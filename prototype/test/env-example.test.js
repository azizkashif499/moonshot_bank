// .env.example is the list of settings the server reads. It had drifted both
// ways: SUSHI_* and TEMPLAR_* were still listed after the code stopped reading
// them, and about twenty settings the code does read were never listed. These
// keep it in step with every process.env.X in server.js and lib/.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EXAMPLE = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");

// Read by the code but not a deployment setting: test/helpers.js sets it to
// "test" to enable test-only hooks.
const NOT_SETTINGS = new Set(["NODE_ENV"]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}

const used = new Set();
for (const file of [path.join(ROOT, "server.js"), ...sourceFiles(path.join(ROOT, "lib"))]) {
  for (const m of fs.readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    if (!NOT_SETTINGS.has(m[1])) used.add(m[1]);
  }
}

// Both `NAME=value` and the commented-out `# NAME=value` form count as listed.
const listed = new Set([...EXAMPLE.matchAll(/^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

test(".env.example lists every setting the server reads", () => {
  assert.ok(used.size > 20, `found only ${used.size} process.env reads; the scan is broken`);
  const missing = [...used].filter((name) => !listed.has(name)).sort();
  assert.deepEqual(missing, [], `add to prototype/.env.example: ${missing.join(", ")}`);
});

test(".env.example lists nothing the server no longer reads", () => {
  const stale = [...listed].filter((name) => !used.has(name)).sort();
  assert.deepEqual(stale, [], `remove from prototype/.env.example: ${stale.join(", ")}`);
});

test("the JSON-valued settings in .env.example parse", () => {
  // These are JSON.parse'd at module load, so a broken value stops the server.
  const parsed = require("dotenv").parse(EXAMPLE);
  for (const name of ["BLEND_POOLS", "AQUA_POOLS", "SOLV_LP_POOLS"]) {
    assert.ok(name in parsed, `${name} is not set in .env.example`);
    assert.doesNotThrow(() => JSON.parse(parsed[name]), `${name} is not valid JSON`);
  }
});
