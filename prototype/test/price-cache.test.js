// "No price" is cached, so unpriced tokens don't cost RPC calls on every load.
//
// The pricing engine cached prices but treated a cached null as a miss, so a
// token with no price re-ran every layer on every request — for a Soroban
// token that means the aggregator's four failing RPC calls each time. A large
// Blend wallet with six such tokens spent ~3.2 of its ~8 seconds there on
// every load, warm or cold, against an 8-second adapter timeout.

require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { StrKey } = require("@stellar/stellar-sdk");

// No real RPC or network: everything a layer could ask is answered "no".
const rpcLib = require("../lib/soroban-rpc");
rpcLib.simulateContractCall = async () => { throw new Error("no RPC in this test"); };
const aggregator = require("../lib/soroswap-aggregator");
let aggregatorCalls = 0;
let aggregatorAnswer = null;
aggregator.priceSorobanTokenInUSD = async () => { aggregatorCalls++; return aggregatorAnswer; };
aggregator.priceClassicAssetViaSACInUSD = async () => { aggregatorCalls++; return aggregatorAnswer; };
const realFetch = global.fetch;
test.before(() => { global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) }); });
test.after(() => { global.fetch = realFetch; });

const pricing = require("../lib/pricing-engine");

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const randomContract = () => StrKey.encodeContract(crypto.randomBytes(32));

test.beforeEach(() => {
  aggregatorCalls = 0;
  aggregatorAnswer = null;
});

test("a Soroban token with no price is asked about once per 5 minutes, not on every load", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const token = randomContract();
  assert.equal(await pricing.priceSorobanToken(token), null);
  assert.equal(await pricing.priceSorobanToken(token), null);
  t.mock.timers.setTime(T0 + 4 * MIN);
  assert.equal(await pricing.priceSorobanToken(token), null);
  assert.equal(aggregatorCalls, 1);

  aggregatorAnswer = { usd: 2.5, change24h: 0, source: "soroswap-aggregator" };
  t.mock.timers.setTime(T0 + 6 * MIN);
  assert.equal((await pricing.priceSorobanToken(token))?.usd, 2.5, "asked again after 5 minutes");
  assert.equal(aggregatorCalls, 2);
});

test("a classic asset with no price doesn't re-run the SDEX layer on every load either", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 + 60 * MIN });
  let sdexCalls = 0;
  const ctx = { priceViaSDEX: async () => { sdexCalls++; return null; } };
  const issuer = "GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP";
  assert.equal(await pricing.priceClassicAsset(ctx, "NOPRICE", issuer), null);
  assert.equal(await pricing.priceClassicAsset(ctx, "NOPRICE", issuer), null);
  assert.equal(sdexCalls, 1);
});

test("a price found is still only kept for a minute", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: T0 + 120 * MIN });
  const token = randomContract();
  aggregatorAnswer = { usd: 1.5, change24h: 0, source: "soroswap-aggregator" };
  await pricing.priceSorobanToken(token);
  t.mock.timers.setTime(T0 + 120 * MIN + 59_000);
  await pricing.priceSorobanToken(token);
  assert.equal(aggregatorCalls, 1, "cached within the minute");
  t.mock.timers.setTime(T0 + 120 * MIN + 61_000);
  await pricing.priceSorobanToken(token);
  assert.equal(aggregatorCalls, 2, "asked again after it");
});
