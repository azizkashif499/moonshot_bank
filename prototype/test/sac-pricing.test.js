// Stellar Asset Contracts (SACs) are priced as the classic asset they wrap.
//
// Much of what Soroban protocols hold is a SAC — Blend's reserves include the
// SACs of EURC, AQUA, CETES, USDGLO and TESOURO — and none of them priced,
// because the Soroban path never looked at the classic asset behind the
// contract. Their positions then dropped out of every total (Blend gates its
// positions on USD value). A SAC's name() is "CODE:ISSUER" and its contract id
// is derived from that asset, so the claim can be verified before trusting it.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { Asset, Keypair, Networks, StrKey, nativeToScVal } = require("@stellar/stellar-sdk");

// Mocks go in before the pricing engine loads: the aggregator destructures
// simulateContractCall at require time.
const rpcLib = require("../lib/soroban-rpc");
const sacId = (code, issuer) => new Asset(code, issuer).contractId(Networks.PUBLIC);

const CIRCLE_EURC = "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2";
const EURC_SAC = "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV"; // Blend's EURC reserve
const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";
const CETES_ISSUER = "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC"; // a 5-character code
const USDC_ISSUER_2 = "GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP"; // on the stablecoin list
const USDT0_SAC = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF"; // in lib/sac-mapping.js
const randomContract = () => StrKey.encodeContract(crypto.randomBytes(32));

const names = new Map(); // contractId → name() answer, or an Error to throw
const nameCalls = [];
rpcLib.simulateContractCall = async (contractId, method) => {
  if (method !== "name") throw new Error(`unexpected ${method}`);
  nameCalls.push(contractId);
  const n = names.get(contractId);
  if (n instanceof Error) throw n;
  return n === undefined ? null : nativeToScVal(n);
};

const aggregator = require("../lib/soroswap-aggregator");
let aggregatorCalls = [];
aggregator.priceSorobanTokenInUSD = async (contractId) => {
  aggregatorCalls.push(contractId);
  return null;
};

const realFetch = global.fetch;
let coinsList = null; // CoinGecko /coins/list answer for the price-map refresh
// The CoinGecko micro-batch timer is unref()'d (the server's listener keeps
// the process alive); without a live handle a test would exit mid-await.
let keepAlive;
test.before(() => {
  keepAlive = setInterval(() => {}, 1000);
  global.fetch = async (url) => {
    url = String(url);
    if (url.includes("/simple/price")) {
      const ids = decodeURIComponent(new URL(url).searchParams.get("ids") || "").split(",");
      const all = {
        "euro-coin": { usd: 1.11, usd_24h_change: -0.2 },
        aquarius: { usd: 0.00029, usd_24h_change: 1.9 },
        cetes: { usd: 0.0635, usd_24h_change: 0.01 },
      };
      const body = Object.fromEntries(ids.filter((id) => all[id]).map((id) => [id, all[id]]));
      return { ok: true, status: 200, json: async () => body };
    }
    if (url.includes("/coins/list") && coinsList) return { ok: true, status: 200, json: async () => coinsList };
    return { ok: false, status: 503, json: async () => ({}) }; // price-map refresh etc.
  };
});
test.after(() => {
  global.fetch = realFetch;
  clearInterval(keepAlive);
});

const sacMapping = require("../lib/sac-mapping");
const pricing = require("../lib/pricing-engine");
const { dedupSACsAgainstClassicBalances } = require("../server.js");

test.beforeEach(() => {
  sacMapping._resetResolvedForTests();
  nameCalls.length = 0;
  aggregatorCalls = [];
});

// ── Recognising a SAC ───────────────────────────────────────────────────────

test("a SAC is recognised from name() only when the contract id matches the asset's", async () => {
  assert.equal(sacId("EURC", CIRCLE_EURC), EURC_SAC);
  names.set(EURC_SAC, `EURC:${CIRCLE_EURC}`);
  assert.deepEqual(await sacMapping.resolveSacAsset(EURC_SAC), { code: "EURC", issuer: CIRCLE_EURC });

  const impostor = randomContract();
  names.set(impostor, `EURC:${CIRCLE_EURC}`);
  assert.equal(await sacMapping.resolveSacAsset(impostor), null, "any contract can claim the name");
});

test("long and lower-case asset codes are recognised; XLM's and non-SAC names are not", async () => {
  const issuer = Keypair.random().publicKey();
  for (const code of ["yXLM", "CETES", "ABCDEFGHIJKL"]) {
    const id = sacId(code, issuer);
    names.set(id, `${code}:${issuer}`);
    assert.deepEqual(await sacMapping.resolveSacAsset(id), { code, issuer }, code);
  }
  const xlm = Asset.native().contractId(Networks.PUBLIC);
  names.set(xlm, "native");
  assert.equal(await sacMapping.resolveSacAsset(xlm), null);
  const token = randomContract();
  names.set(token, "Some Soroban Token");
  assert.equal(await sacMapping.resolveSacAsset(token), null);
});

test("an answer is remembered, and concurrent callers share one call", async () => {
  const token = randomContract();
  names.set(token, "Some Soroban Token");
  await Promise.all([sacMapping.resolveSacAsset(token), sacMapping.resolveSacAsset(token)]);
  await sacMapping.resolveSacAsset(token);
  assert.equal(nameCalls.filter((c) => c === token).length, 1);
});

test("a failed call is not remembered: unknown for a minute, then asked again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const aquaSac = sacId("AQUA", AQUA_ISSUER);
  names.set(aquaSac, new Error("socket hang up"));
  assert.equal(await sacMapping.resolveSacAsset(aquaSac), null);
  names.set(aquaSac, `AQUA:${AQUA_ISSUER}`);
  t.mock.timers.setTime(1_800_000_000_000 + 59_000);
  assert.equal(await sacMapping.resolveSacAsset(aquaSac), null, "not asked again during an outage");
  assert.equal(nameCalls.filter((c) => c === aquaSac).length, 1);
  t.mock.timers.setTime(1_800_000_000_000 + 61_000);
  assert.deepEqual(await sacMapping.resolveSacAsset(aquaSac), { code: "AQUA", issuer: AQUA_ISSUER });
});

test("a SAC already in lib/sac-mapping.js needs no name() lookup", async () => {
  assert.equal((await sacMapping.resolveSacAsset(USDT0_SAC)).code, "USDT0");
  assert.ok(!nameCalls.includes(USDT0_SAC));
});

// ── Pricing ─────────────────────────────────────────────────────────────────

test("Blend's EURC reserve is priced as Circle EURC, before the aggregator is asked", async () => {
  names.set(EURC_SAC, `EURC:${CIRCLE_EURC}`);
  const p = await pricing.priceSorobanToken(EURC_SAC);
  assert.deepEqual(p, { usd: 1.11, change24h: -0.2, source: "coingecko", confidence: "high" });
  assert.deepEqual(aggregatorCalls, []);
});

test("a SAC with a 5-character code (CETES) is priced too", async () => {
  const id = sacId("CETES", CETES_ISSUER);
  names.set(id, `CETES:${CETES_ISSUER}`);
  assert.equal((await pricing.priceSorobanToken(id))?.usd, 0.0635);
});

test("a contract that only *says* it is EURC's SAC is not priced as EURC", async () => {
  const impostor = randomContract();
  names.set(impostor, `EURC:${CIRCLE_EURC}`);
  assert.equal(await pricing.priceSorobanToken(impostor), null);
  assert.deepEqual(aggregatorCalls, [impostor], "it falls through to the aggregator as before");
});

test("look-alike EURC SACs don't inherit Circle's price: another issuer, or one sharing its first 12 characters", async () => {
  const other = Keypair.random().publicKey();
  // A valid key that matches Circle's issuer for 12 characters, then differs.
  let vanity;
  do {
    vanity = Keypair.random().publicKey();
    vanity = CIRCLE_EURC.slice(0, 12) + vanity.slice(12);
  } while (!StrKey.isValidEd25519PublicKey(vanity));
  for (const issuer of [other, vanity]) {
    const id = sacId("EURC", issuer);
    names.set(id, `EURC:${issuer}`);
    assert.equal(await pricing.priceSorobanToken(id), null, issuer);
  }
});

test("full issuers from CoinGecko's list tighten strict lookups; short ones don't loosen them", async () => {
  const priceMap = require("../lib/token-price-map");
  const real = Keypair.random().publicKey();
  const vanity = real.slice(0, 30) + Keypair.random().publicKey().slice(30);
  const shortListed = Keypair.random().publicKey();
  coinsList = [
    { id: "aquarius", platforms: { stellar: `AQUA-${AQUA_ISSUER}` } }, // seeded with 30 characters
    { id: "new-coin", platforms: { stellar: `NEWC-${real}` } },
    { id: "short-coin", platforms: { stellar: `SHRT-${shortListed.slice(0, 20)}` } },
  ];
  try {
    await priceMap.refreshFromCoinGecko();
  } finally {
    coinsList = null;
  }
  assert.equal(priceMap.lookupClassic("NEWC", real, { strict: true }), "new-coin");
  assert.equal(priceMap.lookupClassic("NEWC", vanity, { strict: true }), null, "a key that shares only the first 30 characters");
  assert.equal(priceMap.lookupClassic("SHRT", shortListed, { strict: true }), null, "a 20-character issuer can't vouch for anything");
  // AQUA's seed issuer is truncated to 30 characters; the full one now applies.
  assert.equal(priceMap.lookupClassic("AQUA", AQUA_ISSUER, { strict: true }), "aquarius");
  const aquaVanity = AQUA_ISSUER.slice(0, 30) + Keypair.random().publicKey().slice(30);
  assert.equal(priceMap.lookupClassic("AQUA", aquaVanity, { strict: true }), null);
  assert.equal(priceMap.lookupClassic("SHRT", shortListed), "short-coin", "non-strict lookups are unchanged");
});

test("a SAC of a listed stablecoin is $1", async () => {
  const id = sacId("USDC", USDC_ISSUER_2);
  names.set(id, `USDC:${USDC_ISSUER_2}`);
  assert.deepEqual(await pricing.priceSorobanToken(id), { usd: 1, change24h: 0, source: "stablecoin", confidence: "high" });
});

test("a token that isn't a SAC still goes to the aggregator", async () => {
  const token = randomContract();
  names.set(token, "Some Soroban Token");
  await pricing.priceSorobanToken(token);
  assert.ok(aggregatorCalls.includes(token));
});

// ── No double counting ──────────────────────────────────────────────────────

test("a discovered SAC row is never added to a G-account's balances", async () => {
  names.set(EURC_SAC, `EURC:${CIRCLE_EURC}`);
  const token = randomContract();
  names.set(token, "Some Soroban Token");
  const unreadable = randomContract();
  names.set(unreadable, new Error("socket hang up"));
  const discovered = [EURC_SAC, token, unreadable].map((contractId) => ({ asset: { contractId }, valueUSD: 100 }));
  const eurcTrustline = { type: "token", balance: "10.0000000", asset: { code: "EURC", issuer: CIRCLE_EURC } };

  // Holding EURC: the SAC row is the same holding.
  let kept = await dedupSACsAgainstClassicBalances(discovered, [eurcTrustline]);
  assert.deepEqual(kept.map((t) => t.asset.contractId), [token, unreadable]);

  // EURC sold (an empty trustline isn't listed), but discovery still has a
  // cached non-zero row: still dropped, now that it would carry a price.
  kept = await dedupSACsAgainstClassicBalances(discovered, []);
  assert.deepEqual(kept.map((t) => t.asset.contractId), [token, unreadable], "a token we can't check is kept, as before");
});
