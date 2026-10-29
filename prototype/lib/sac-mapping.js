/**
 * Stellar Asset Contract (SAC) ↔ Classic Asset Mapping
 *
 * On Stellar, classic assets (native XLM, classic-issued tokens like Circle's
 * USDC) can be wrapped into Soroban contracts called SACs (Stellar Asset
 * Contracts). The wrapped balance is the same economic asset as the underlying
 * classic balance — they're two interfaces to the same value.
 *
 * Problem: our probe-based Soroban discovery (token-universe.js) includes the
 * well-known SACs, so wallets that hold the underlying classic asset also
 * appear to "hold" the SAC at the same amount. This double-counts value:
 * a wallet with 100 XLM appears as 100 XLM native + 100 XLM SAC = 200 XLM.
 *
 * Solution: this mapping lets the server merge the two representations into
 * a single balance entry, attributing the value once to the underlying
 * classic asset (which is what the user actually holds).
 *
 * Currently mapped:
 *   - XLM SAC  ↔ native XLM
 *   - USDC SAC ↔ Circle USDC (GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN)
 *
 * Additional SAC pairs can be added here as we learn about them. If a
 * Soroban-only token (no classic representation) is in our universe, it
 * does NOT need an entry here — it correctly shows up only on the Soroban
 * side.
 */

const StellarSdk = require("@stellar/stellar-sdk");
// Used as rpc.simulateContractCall (not destructured) so tests can stub it.
const rpc = require("./soroban-rpc");

// SAC contract ID → classic asset descriptor that it wraps
const SAC_TO_CLASSIC = {
  // Native XLM Stellar Asset Contract
  "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA": {
    type: "native",
    code: "XLM",
    issuer: null,
  },
  // Circle's USDC Stellar Asset Contract
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75": {
    type: "credit_alphanum4",
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  // USDT0 (Tether omnichain USDT, operated by Everdawn Labs)
  "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF": {
    type: "credit_alphanum12",
    code: "USDT0",
    issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
  },
};

/**
 * Get the classic asset descriptor wrapped by a SAC contract ID, or null if
 * the contract is not a known SAC.
 */
function classicForSAC(contractId) {
  return SAC_TO_CLASSIC[contractId] || null;
}

/**
 * Check whether a balance entry from the classic side matches the underlying
 * classic asset of a SAC entry. Used by the deduplication logic in server.js.
 */
function classicMatches(classicEntry, sacUnderlying) {
  if (!classicEntry || !sacUnderlying) return false;
  if (classicEntry.type !== sacUnderlying.type) return false;
  if (sacUnderlying.type === "native") return true; // both native
  // For credit_alphanum* types, compare code + issuer
  const eAsset = classicEntry.asset || {};
  return eAsset.code === sacUnderlying.code && eAsset.issuer === sacUnderlying.issuer;
}

/**
 * Return true if the given contractId is a SAC for a well-known classic asset.
 */
function isKnownSAC(contractId) {
  return Object.prototype.hasOwnProperty.call(SAC_TO_CLASSIC, contractId);
}

// ── Any SAC, not just the ones listed above ─────────────────────────────────
//
// A SAC's name() is "CODE:ISSUER", and its contract id is derived from that
// asset, so the claim can be checked: any contract can *call* itself
// "EURC:GDHU...", but only the real SAC has that asset's derived id (a Wasm
// contract's id is derived differently, so it cannot collide with one).

const resolved = new Map(); // contractId → { code, issuer } | null (not a SAC)
const inFlight = new Map(); // contractId → Promise, so concurrent callers share one call
const failedAt = new Map(); // contractId → ms of the last failed call
// After a failed call (RPC trouble), answer "unknown" without asking again for
// a minute, so an outage doesn't add a retried RPC call per row per request.
const FAILURE_BACKOFF_MS = 60_000;

/**
 * The classic asset a contract wraps, if it is a Stellar Asset Contract for
 * an issued asset: { code, issuer }, else null. The XLM SAC (name "native")
 * resolves to null here; callers handle native separately. One name() call
 * per contract per process; a call that fails is not remembered.
 */
async function resolveSacAsset(contractId) {
  if (resolved.has(contractId)) return resolved.get(contractId);
  const known = classicForSAC(contractId);
  if (known && known.issuer) return { code: known.code, issuer: known.issuer };
  if (Date.now() - (failedAt.get(contractId) || 0) < FAILURE_BACKOFF_MS) return null;
  if (!inFlight.has(contractId)) {
    inFlight.set(contractId, _lookup(contractId).finally(() => inFlight.delete(contractId)));
  }
  return inFlight.get(contractId);
}

async function _lookup(contractId) {
  let asset = null;
  try {
    const r = await rpc.simulateContractCall(contractId, "name");
    const name = r ? StellarSdk.scValToNative(r) : null;
    const m = typeof name === "string" && name.match(/^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/);
    if (m) {
      const classic = new StellarSdk.Asset(m[1], m[2]);
      if (classic.contractId(StellarSdk.Networks.PUBLIC) === contractId) asset = { code: m[1], issuer: m[2] };
    }
  } catch (e) {
    failedAt.set(contractId, Date.now()); // could not ask: don't remember an answer
    return null;
  }
  resolved.set(contractId, asset); // a contract's name and id never change
  return asset;
}

module.exports = {
  SAC_TO_CLASSIC,
  classicForSAC,
  classicMatches,
  isKnownSAC,
  resolveSacAsset,
  _resetResolvedForTests: () => {
    resolved.clear();
    inFlight.clear();
    failedAt.clear();
  },
};
