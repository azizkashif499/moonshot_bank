// CoinGecko prices are not served stale forever.
//
// When a CoinGecko request failed (its free tier rate-limits shared server
// IPs often), the pricing engine served that id's last price — with no age
// limit and nothing to say it was old — and, since that counted as a price,
// the SDEX and aggregator layers were never tried. An outage of hours meant
// hours-old prices in every portfolio and snapshot. Now a stale price is
// marked stale and served for at most 15 minutes; after that the asset falls
// through to the next layer.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

// No real RPC: anything that asks a contract (e.g. its name()) is told no.
const rpcLib = require("../lib/soroban-rpc");
rpcLib.simulateContractCall = async () => { throw new Error("no RPC in this test"); };

const aggregator = require("../lib/soroswap-aggregator");
let aggregatorAnswer = null;
aggregator.priceClassicAssetViaSACInUSD = async () => aggregatorAnswer;
aggregator.priceSorobanTokenInUSD = async () => aggregatorAnswer;

const pricing = require("../lib/pricing-engine");

const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const SOLVBTC = "CBIJBDNZNF4X35BJ4FFZWCDBSCKOP5NB4PLG4SNENRMLAPYG4P5FM6VN"; // a Soroban token in the CoinGecko map
const T0 = 1_800_000_000_000;
const MIN = 60_000;

let coingeckoUp = true;
let sdexCalls = 0;
const ctx = { priceViaSDEX: async () => { sdexCalls++; return { usd: 0.00031, change24h: 0 }; } };

const realFetch = global.fetch;
let keepAlive; // the CoinGecko batch timer is unref()'d; keep the test alive
test.before(() => {
  keepAlive = setInterval(() => {}, 1000);
  global.fetch = async (url) => {
    url = String(url);
    if (url.includes("/simple/price") && coingeckoUp) {
      const body = { aquarius: { usd: 0.00029, usd_24h_change: 1.9 }, "solv-btc": { usd: 104_000, usd_24h_change: -1.2 } };
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 429, json: async () => ({}) };
  };
});
test.after(() => {
  global.fetch = realFetch;
  clearInterval(keepAlive);
});

test.beforeEach(() => {
  coingeckoUp = true;
  sdexCalls = 0;
  aggregatorAnswer = null;
});

test("a classic asset: fresh, then stale (marked) for up to 15 minutes, then the SDEX layer", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const fresh = await pricing.priceClassicAsset(ctx, "AQUA", AQUA_ISSUER);
  assert.deepEqual(fresh, { usd: 0.00029, change24h: 1.9, source: "coingecko", confidence: "high" });

  coingeckoUp = false;
  t.mock.timers.setTime(T0 + 14 * MIN);
  const stale = await pricing.priceClassicAsset(ctx, "AQUA", AQUA_ISSUER);
  assert.deepEqual(stale, { usd: 0.00029, change24h: 1.9, source: "coingecko", confidence: "high", stale: true, asOf: T0 });
  assert.equal(sdexCalls, 0, "a recent CoinGecko price is still preferred");

  t.mock.timers.setTime(T0 + 16 * MIN);
  const later = await pricing.priceClassicAsset(ctx, "AQUA", AQUA_ISSUER);
  assert.equal(later.source, "sdex");
  assert.equal(later.usd, 0.00031);
  assert.equal(sdexCalls, 1);

  coingeckoUp = true; // and when CoinGecko is back, so is a fresh price
  t.mock.timers.setTime(T0 + 18 * MIN);
  const back = await pricing.priceClassicAsset(ctx, "AQUA", AQUA_ISSUER);
  assert.equal(back.source, "coingecko");
  assert.equal(back.stale, undefined);
});

test("a Soroban token: stale for up to 15 minutes, then the aggregator, else unpriced", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 + 60 * MIN });
  assert.equal((await pricing.priceSorobanToken(SOLVBTC)).usd, 104_000);

  coingeckoUp = false;
  t.mock.timers.setTime(T0 + 70 * MIN);
  assert.equal((await pricing.priceSorobanToken(SOLVBTC)).stale, true);

  t.mock.timers.setTime(T0 + 80 * MIN);
  assert.equal(await pricing.priceSorobanToken(SOLVBTC), null, "no other source: unpriced, not frozen");

  // Once another source has a price, a later lookup finds it. (Six minutes
  // on, so this holds even when "no price" answers are cached for a while.)
  aggregatorAnswer = { usd: 103_500, change24h: 0, source: "soroswap-aggregator" };
  t.mock.timers.setTime(T0 + 86 * MIN);
  assert.equal((await pricing.priceSorobanToken(SOLVBTC)).source, "soroswap-aggregator");
});
