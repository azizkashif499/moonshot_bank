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

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const helmet = require("helmet");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

/**
 * CSP hash-sources for every inline <script> block in the static pages.
 *
 * The browser hashes a script element's text exactly as the HTML parser sees
 * it, and the parser turns CRLF and lone CR into LF before it does anything
 * else. A Windows checkout with core.autocrlf stores index.html with CRLF, so
 * the text is normalised the same way here; hashing the raw bytes would give a
 * value the browser never computes, and every inline script would be blocked.
 *
 * Computed once at boot from the files express.static serves, so editing an
 * inline script needs a restart, not a hand-maintained hash list.
 */
function inlineScriptHashes(html) {
  const hashes = [];
  for (const m of html.replace(/\r\n?/g, "\n").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/(?:^|\s)src\s*=/i.test(m[1])) continue; // external file: covered by 'self' (data-src= is not src=)
    const digest = crypto.createHash("sha256").update(m[2], "utf8").digest("base64");
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

function staticPageScriptHashes(dir = PUBLIC_DIR) {
  const hashes = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort()) {
    for (const h of inlineScriptHashes(fs.readFileSync(path.join(dir, file), "utf8"))) hashes.add(h);
  }
  return [...hashes];
}

// Exported so the header test can assert on it and so it is impossible to
// change by accident.
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],

  // No 'unsafe-inline': an injected <script> or on*= attribute does not run.
  // The page's own inline <script> blocks (four, in index.html) are allowed by
  // their sha256 hashes, computed at boot above. The on*= attributes that used
  // to need 'unsafe-inline' are gone: all 68 route through the delegated
  // data-action listener in index.html, and test/label-xss.test.js fails if
  // one comes back. Event handlers assigned from JavaScript (el.onclick = fn)
  // are not affected by CSP and still work.
  //
  // To add an inline script, just add it: the hash follows on the next start,
  // and test/headers.test.js checks every inline block on every HTML route is
  // covered. Server-generated HTML (/api/docs) must not contain inline
  // scripts; the same test fails if it does.
  scriptSrc: ["'self'", ...staticPageScriptHashes()],

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

module.exports = { installSecurityHeaders, CSP_DIRECTIVES, inlineScriptHashes };
