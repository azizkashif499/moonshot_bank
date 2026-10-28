/**
 * Price ticker resolver — prices for the marquee banner.
 *
 * Source: the same pricing the portfolio uses, so the banner and a wallet's
 * totals can never disagree:
 *   - XLM: getXLMPrice (lib/xlm-price.js — Stellar's DEX, then CoinGecko)
 *   - the classic assets: pricingEngine.priceClassicAsset (CoinGecko via the
 *     token price map, then SDEX, then the Soroswap aggregator)
 * Both are injected by server.js, which owns the SDEX helper they need.
 *
 * This used to call the Freighter backend's /token-prices endpoint directly.
 * In late October 2026 that feed was found wrong for every ticker token, with
 * no timestamp to tell: XLM $0.2152 (stuck; ~$0.172), AQUA $0.089 (~$0.00029,
 * a price AQUA hasn't had in the past year), BLND $0.0038 (~$0.0063) and
 * EURC $1.144 (~$1.110).
 *
 * Caching:
 *   30-second in-memory cache. The marquee polls every 30s so this avoids any
 *   chance of hammering the upstream even if multiple browser tabs are open.
 *   A result with an unpriced token is kept for 10 seconds only, so one failed
 *   lookup doesn't blank that token for a whole cycle.
 *
 * 24h change:
 *   Shown only when the source reports one (CoinGecko, or SDEX trades for
 *   XLM). The SDEX order-book fallback for other assets has no 24h figure,
 *   so the UI hides the percentage rather than showing a fake 0.00%. Any
 *   change outside ±200% is treated as bad data and hidden too.
 */

const CHANGE_SANITY_BOUND = 200; // |24h change %| above this is treated as bad data
const CACHE_TTL_MS = 30 * 1000;
const PARTIAL_CACHE_TTL_MS = 10 * 1000;

let cache = { ts: 0, ttl: 0, data: null };

// Tokens shown in the marquee. Order is the display order.
const TOKENS = [
  { symbol: "XLM", name: "Stellar Lumens", native: true },
  { symbol: "AQUA", name: "Aquarius", code: "AQUA", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
  { symbol: "BLND", name: "Blend", code: "BLND", issuer: "GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY" },
  { symbol: "EURC", name: "Euro Coin", code: "EURC", issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2" },
];

// Classic-asset sources whose change24h is a real 24h figure (the SDEX
// order-book path reports 0 for "unknown").
const SOURCES_WITH_CHANGE = new Set(["coingecko"]);

function sanityCheckChange(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return null;
  if (Math.abs(pct) > CHANGE_SANITY_BOUND) return null;
  return pct;
}

async function priceToken(t, deps) {
  try {
    if (t.native) {
      const p = await deps.getXLMPrice();
      if (!(p?.usd > 0)) return { price: null, change24h: null };
      return { price: p.usd, change24h: p.change24hKnown ? p.change24h : null };
    }
    const p = await deps.priceClassic(t.code, t.issuer);
    if (!(p?.usd > 0)) return { price: null, change24h: null };
    return { price: p.usd, change24h: SOURCES_WITH_CHANGE.has(p.source) ? p.change24h : null };
  } catch (e) {
    console.warn(`Ticker: ${t.symbol} price failed: ${e.message}`);
    return { price: null, change24h: null };
  }
}

/**
 * Public entry point. `deps` = { getXLMPrice, priceClassic(code, issuer) }.
 * Returns:
 *   {
 *     tokens: [
 *       { symbol, name, price, change24h },   // price/change24h null if unknown
 *       ...
 *     ],
 *     updatedAt: <epoch ms>,
 *     cached: <bool>,
 *   }
 * Throws only if no token could be priced at all.
 */
async function getTickerPrices(deps) {
  const now = Date.now();
  if (cache.data && now - cache.ts < cache.ttl) {
    return { ...cache.data, cached: true };
  }
  const priced = await Promise.all(TOKENS.map((t) => priceToken(t, deps)));
  if (priced.every((p) => p.price == null)) {
    throw new Error("no ticker token could be priced");
  }
  const tokens = TOKENS.map((t, i) => ({
    symbol: t.symbol,
    name: t.name,
    price: priced[i].price,
    change24h: sanityCheckChange(priced[i].change24h),
  }));
  const fresh = { tokens, updatedAt: now };
  const complete = tokens.every((t) => t.price != null);
  cache = { ts: now, ttl: complete ? CACHE_TTL_MS : PARTIAL_CACHE_TTL_MS, data: fresh };
  return { ...fresh, cached: false };
}

function _resetForTests() {
  cache = { ts: 0, ttl: 0, data: null };
}

module.exports = { getTickerPrices, _resetForTests, TOKENS, CACHE_TTL_MS, PARTIAL_CACHE_TTL_MS };
