// XLM/USD and the price ticker.
//
// Both used to come from the Freighter backend's /token-prices feed, which in
// late October 2026 was found stuck (XLM $0.2152 while it traded at ~$0.172),
// with no timestamp to tell. XLM now comes from Stellar's own DEX (the
// XLM/USDC book on Horizon), with CoinGecko as the fallback, and the ticker
// shows the same prices the portfolio uses.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const xlmPrice = require("../lib/xlm-price");
const ticker = require("../lib/price-ticker");

const HOUR = 3_600_000;
const USDC = xlmPrice.USDC_ISSUER;

// ── A fake network ──────────────────────────────────────────────────────────

let net; // per-test answers
const seen = [];
let realFetch;

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function fakeFetch(url) {
  url = String(url);
  seen.push(url);
  if (url.includes("freighter")) throw new Error("the Freighter price feed must not be used");
  if (url.includes("/order_book")) return net.book(url);
  if (url.includes("/trade_aggregations")) return net.trades(url);
  if (url.includes("coingecko.com/api/v3/simple/price")) return net.coingecko(url);
  if (url.includes("coingecko.com/api/v3/coins/list")) return json({}, 503); // price-map refresh
  throw new Error(`unexpected fetch ${url}`);
}

test.before(() => {
  realFetch = global.fetch;
  global.fetch = fakeFetch;
});
test.after(() => {
  global.fetch = realFetch;
});

// Hourly buckets, newest first, as Horizon returns them with order=desc.
function hourly(closes) {
  const top = Math.floor(Date.now() / HOUR) * HOUR;
  return { _embedded: { records: closes.map((close, i) => ({ timestamp: String(top - i * HOUR), close: String(close) })) } };
}

const BID = 0.1716915;
const ASK = 0.1719181;
const MID = (BID + ASK) / 2;

function normalNet() {
  return {
    book: () => json({ bids: [{ price: String(BID) }], asks: [{ price: String(ASK) }] }),
    // Hourly closes, newest first; the bucket holding "24h ago" (index 24) closes at 0.1675.
    trades: () => json(hourly(Array.from({ length: 30 }, (_, i) => (i < 24 ? 0.1718 : i === 24 ? 0.1675 : 0.1600)))),
    coingecko: (url) => {
      const all = {
        stellar: { usd: 0.1717, usd_24h_change: 2.2 },
        aquarius: { usd: 0.00029, usd_24h_change: 1.9 },
        blend: { usd: 0.0063, usd_24h_change: 3.4 },
        "euro-coin": { usd: 1.11, usd_24h_change: -0.2 },
      };
      const ids = decodeURIComponent(new URL(url).searchParams.get("ids") || "").split(",");
      return json(Object.fromEntries(ids.filter((id) => all[id]).map((id) => [id, all[id]])));
    },
  };
}

const count = (part) => seen.filter((u) => u.includes(part)).length;

test.beforeEach(() => {
  xlmPrice._resetForTests();
  ticker._resetForTests();
  net = normalNet();
  seen.length = 0;
});

// ── getXLMPrice ─────────────────────────────────────────────────────────────

test("XLM comes from the SDEX XLM/USDC book: the mid price, and the 24h change from SDEX trades", async () => {
  const p = await xlmPrice.getXLMPrice();
  assert.equal(p.source, "sdex");
  assert.equal(p.usd, MID);
  assert.equal(p.change24hKnown, true);
  // Compared with the close of the hourly bucket that contains "24h ago"
  // (index 24), not a newer one (0.1718) or an older one (0.1600).
  assert.ok(Math.abs(p.change24h - (MID / 0.1675 - 1) * 100) < 1e-9, `change ${p.change24h}`);

  // The right markets, in the right direction: USDC per XLM, Circle's USDC.
  const book = new URL(seen.find((u) => u.includes("/order_book"))).searchParams;
  assert.equal(book.get("selling_asset_type"), "native");
  assert.equal(book.get("buying_asset_code"), "USDC");
  assert.equal(book.get("buying_asset_issuer"), USDC);
  const trades = new URL(seen.find((u) => u.includes("/trade_aggregations"))).searchParams;
  assert.equal(trades.get("base_asset_type"), "native");
  assert.equal(trades.get("counter_asset_code"), "USDC");
  assert.equal(trades.get("counter_asset_issuer"), USDC);
  assert.equal(trades.get("resolution"), String(HOUR));
});

test("cached for a minute, then asked again; concurrent callers share one request", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  await Promise.all([xlmPrice.getXLMPrice(), xlmPrice.getXLMPrice(), xlmPrice.getXLMPrice()]);
  assert.equal(count("/order_book"), 1, "one request for three concurrent callers");
  t.mock.timers.setTime(1_800_000_000_000 + 59_000);
  await xlmPrice.getXLMPrice();
  assert.equal(count("/order_book"), 1, "still cached at 59s");
  t.mock.timers.setTime(1_800_000_000_000 + 61_000);
  await xlmPrice.getXLMPrice();
  assert.equal(count("/order_book"), 2, "asked again after 60s");
});

test("a book that is wider than 2%, crossed or one-sided falls back to CoinGecko", async () => {
  const cases = [
    [{ bids: [{ price: "0.1700" }], asks: [{ price: "0.1739" }] }, "coingecko"], // 2.3% wide
    [{ bids: [{ price: "0.1700" }], asks: [{ price: "0.1732" }] }, "sdex"], //       1.9%: fine
    [{ bids: [{ price: "0.1720" }], asks: [{ price: "0.1710" }] }, "coingecko"], // crossed
    [{ bids: [], asks: [{ price: "0.18" }] }, "coingecko"], //                       one-sided
  ];
  for (const [book, source] of cases) {
    xlmPrice._resetForTests();
    net.book = () => json(book);
    const p = await xlmPrice.getXLMPrice();
    assert.equal(p.source, source, JSON.stringify(book));
    if (source === "coingecko") assert.deepEqual([p.usd, p.change24h, p.change24hKnown], [0.1717, 2.2, true]);
  }
});

test("Horizon down falls back to CoinGecko", async () => {
  net.book = () => json({}, 503);
  assert.equal((await xlmPrice.getXLMPrice()).source, "coingecko");
});

test("a 24h change the source doesn't have is marked unknown, not reported as 0%", async () => {
  net.trades = () => json({}, 500);
  let p = await xlmPrice.getXLMPrice();
  assert.deepEqual([p.source, p.usd, p.change24h, p.change24hKnown], ["sdex", MID, 0, false]);

  xlmPrice._resetForTests();
  net.book = () => json({}, 503);
  net.coingecko = () => json({ stellar: { usd: 0.1717 } });
  p = await xlmPrice.getXLMPrice();
  assert.deepEqual([p.source, p.change24hKnown], ["coingecko", false]);
});

test("every source down: the last good price, marked stale; sources rested for 15s", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const good = await xlmPrice.getXLMPrice();
  net.book = () => json({}, 503);
  net.coingecko = () => json({}, 429);

  t.mock.timers.setTime(1_800_000_000_000 + 61_000); // past the cache
  const stale = await xlmPrice.getXLMPrice();
  assert.deepEqual(stale, {
    ...good, change24h: 0, change24hKnown: false, stale: true, asOf: 1_800_000_000_000,
  });
  const asked = seen.length;
  t.mock.timers.setTime(1_800_000_000_000 + 70_000);
  assert.equal((await xlmPrice.getXLMPrice()).stale, true);
  assert.equal(seen.length, asked, "no new requests within 15s of the failure");
  t.mock.timers.setTime(1_800_000_000_000 + 77_000);
  await xlmPrice.getXLMPrice();
  assert.ok(seen.length > asked, "asked again after 15s");
});

test("every source down and no price yet: 0, said plainly, and the next call tries again", async () => {
  net.book = () => json({}, 503);
  net.coingecko = () => json({}, 429);
  assert.deepEqual(await xlmPrice.getXLMPrice(), { usd: 0, change24h: 0, change24hKnown: false, source: "none" });
  net = normalNet(); // the sources recover a moment later
  assert.equal((await xlmPrice.getXLMPrice()).usd, MID, "no back-off before the first good price");
});

// ── The ticker ──────────────────────────────────────────────────────────────

const deps = (over = {}) => ({
  getXLMPrice: async () => ({ usd: 0.1717, change24h: 2.5, change24hKnown: true, source: "sdex" }),
  priceClassic: async (code) => ({
    AQUA: { usd: 0.00029, change24h: 1.9, source: "coingecko" },
    BLND: { usd: 0.0063, change24h: 0, source: "sdex" }, // order book: no 24h figure
    EURC: { usd: 1.11, change24h: -0.2, source: "coingecko" },
  })[code],
  ...over,
});

test("the ticker shows the portfolio's own prices, and no change where the source has none", async () => {
  const r = await ticker.getTickerPrices(deps());
  assert.deepEqual(r.tokens, [
    { symbol: "XLM", name: "Stellar Lumens", price: 0.1717, change24h: 2.5 },
    { symbol: "AQUA", name: "Aquarius", price: 0.00029, change24h: 1.9 },
    { symbol: "BLND", name: "Blend", price: 0.0063, change24h: null },
    { symbol: "EURC", name: "Euro Coin", price: 1.11, change24h: -0.2 },
  ]);
  assert.equal(r.cached, false);
  assert.equal(seen.length, 0, "the ticker makes no requests of its own");
});

test("the ticker hides an unknown or absurd change, and a token it can't price", async () => {
  const r = await ticker.getTickerPrices(deps({
    getXLMPrice: async () => ({ usd: 0.1717, change24h: 0, change24hKnown: false, source: "sdex" }),
    priceClassic: async (code) => {
      if (code === "AQUA") throw new Error("429");
      if (code === "BLND") return null;
      return { usd: 1.11, change24h: 666, source: "coingecko" };
    },
  }));
  const by = Object.fromEntries(r.tokens.map((t) => [t.symbol, t]));
  assert.equal(by.XLM.change24h, null);
  assert.equal(by.AQUA.price, null);
  assert.equal(by.BLND.price, null);
  assert.equal(by.EURC.change24h, null, "±200% is bad data");
});

test("the ticker caches a full result for 30s, one with a gap for 10s", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  await ticker.getTickerPrices(deps());
  t.mock.timers.setTime(1_800_000_000_000 + 29_000);
  assert.equal((await ticker.getTickerPrices(deps())).cached, true);
  t.mock.timers.setTime(1_800_000_000_000 + 31_000);
  assert.equal((await ticker.getTickerPrices(deps({ priceClassic: async () => null }))).cached, false);
  t.mock.timers.setTime(1_800_000_000_000 + 40_000);
  assert.equal((await ticker.getTickerPrices(deps())).cached, true, "a gap is kept for 10s");
  t.mock.timers.setTime(1_800_000_000_000 + 42_000);
  assert.equal((await ticker.getTickerPrices(deps())).cached, false, "and then retried");
});

test("the ticker fails only when nothing at all can be priced", async () => {
  await assert.rejects(ticker.getTickerPrices({
    getXLMPrice: async () => ({ usd: 0, change24h: 0, change24hKnown: false, source: "none" }),
    priceClassic: async () => null,
  }));
});

// ── Wired into the server ───────────────────────────────────────────────────

test("GET /api/v1/prices/ticker serves the SDEX XLM price and CoinGecko's for the others", async () => {
  const { app } = require("../server.js");
  const res = await request(app, "GET", "/api/v1/prices/ticker");
  assert.equal(res.status, 200, res.raw);
  const by = Object.fromEntries(res.body.tokens.map((t) => [t.symbol, t]));
  assert.equal(by.XLM.price, MID);
  assert.equal(by.AQUA.price, 0.00029);
  assert.equal(by.BLND.price, 0.0063);
  assert.equal(by.EURC.price, 1.11);
  assert.equal(count("freighter"), 0);
});

test("no price comes from the Freighter token-prices feed any more", () => {
  const root = path.join(__dirname, "..");
  const files = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []);
  for (const f of ["server.js", ...files("lib")]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!src.includes("/api/v1/token-prices"), `${f} still calls it`);
  }
});
