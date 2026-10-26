/**
 * Security headers.
 *
 * The app shipped with no Content-Security-Policy anywhere, no helmet, and
 * `X-Powered-By: Express`. The missing CSP mattered most because it is what
 * would have contained the stored-XSS in wallet labels: with no policy, an
 * injected script could load anything from anywhere and post the results
 * wherever it liked.
 *
 * Every directive below is derived from what the code actually does, not from a
 * template. The only external hosts referenced anywhere in public/index.html
 * are stellar.creit.tech (wallet-picker icons), a Pinata gateway (two hero
 * images), and stellar.expert / stellarx.com — the last two as href targets,
 * which no directive governs.
 */

const helmet = require("helmet");

// `unsafe-inline` for scripts is a KNOWN, TEMPORARY weakness — see the comment
// on scriptSrc below. Exported so the header test can assert on it and so it is
// impossible to change by accident.
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],

  // NOT LOCKED DOWN YET, and this must not be mistaken for one that is.
  //
  // With 'unsafe-inline' the policy is not an XSS backstop. It IS a backstop
  // against an injected <script src> pointing at an attacker's host, an
  // injected <object>/<embed>, a rewritten <base>, framing, and form-based
  // exfiltration — all of which the directives below do block.
  //
  // What stands in the way of `script-src 'self'`: the four inline <script>
  // blocks in index.html (a nonce or a hash solves those). The static on*=
  // attributes, which were constant strings and so CSP blockers rather than
  // injection vectors, are gone: all 68 (66 onclick, 2 onkeydown) now route
  // through the delegated data-action listener in index.html, and
  // test/label-xss.test.js fails if one comes back.
  //
  // Count them with `grep -oE '\son[a-z]+="' public/index.html`, NOT with
  // `grep -o 'on[a-z]*="'`: that pattern also matches the tail of
  // `data-action="` and `content="`, which is how the figure 78 was first
  // mis-stated as the post-change count.
  scriptSrc: ["'self'", "'unsafe-inline'"],

  // REQUIRED. index.html carries a large <style> block plus inline style="…"
  // attributes on 191 lines, many built at render time
  // (style="background: ${color};"). Without this, defaultSrc 'self' blocks
  // every one of them and the app renders completely unstyled.
  styleSrc: ["'self'", "'unsafe-inline'"],

  // Deliberately broad, and it has to be. NFT card images are rendered from
  // arbitrary on-chain token_uri metadata, so the host set is unbounded and no
  // fixed allowlist can work — an allowlist would silently blank the NFTs tab.
  // Blanket https: still blocks http: and every non-https scheme, and safeUrl()
  // in the page rejects anything that is not https or same-origin before it
  // ever reaches an src attribute.
  imgSrc: ["'self'", "data:", "https:"],

  // 'self' is sufficient: API_BASE is window.location.origin and the only other
  // browser fetch is the relative /rwa-catalog.json. Horizon, Soroban RPC and
  // CoinGecko are called SERVER-side; they do not belong here, because
  // connect-src governs the browser.
  connectSrc: ["'self'"],

  fontSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};

/**
 * Install security headers on an express app.
 *
 * @param {import("express").Express} app
 * @param {{ reportOnly?: boolean }} options
 *   reportOnly sends Content-Security-Policy-Report-Only instead of enforcing.
 *   Set CSP_REPORT_ONLY=1 on a preview deploy to collect violations before
 *   turning the policy on for real.
 */
function installSecurityHeaders(app, { reportOnly = process.env.CSP_REPORT_ONLY === "1" } = {}) {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: CSP_DIRECTIVES,
        reportOnly,
      },
      // CRITICAL: helmet's DEFAULT is `no-referrer`, which strips Referer from
      // same-origin requests too. sameOriginOnly() accepts an allowlisted
      // Origin or an allowlisted Referer-derived origin, and browsers send no
      // Origin header at all on same-origin GETs — so the default would have
      // 403'd GET /api/v1/whales and GET /api/v1/portfolio-whales for EVERY
      // user, generalising the failure that referrer-stripping extensions
      // already caused. `same-origin` keeps the header for our own requests and
      // drops it cross-origin.
      referrerPolicy: { policy: "same-origin" },
      // Cross-origin isolation headers are off: they would break the
      // third-party wallet-icon images and any popup-based wallet flow, for no
      // benefit to an app that embeds nothing and is embedded nowhere.
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
    })
  );
}

module.exports = { installSecurityHeaders, CSP_DIRECTIVES };
