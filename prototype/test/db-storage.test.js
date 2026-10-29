// The history database must live on a Railway volume, or every deploy deletes
// it. describeStorage() tells the cases apart; /api/health reports the result.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");

const { app } = require("../server.js");
const { describeStorage } = require("../lib/history-db");

const RAILWAY = { RAILWAY_ENVIRONMENT_ID: "env-123" };

test("not on Railway: local, no warning", () => {
  assert.deepEqual(describeStorage("/home/me/prototype/data/history.db", {}), { storage: "local", warning: null });
});

test("on Railway with no volume: ephemeral, and the warning says to attach one", () => {
  const r = describeStorage("/app/prototype/data/history.db", RAILWAY);
  assert.equal(r.storage, "ephemeral");
  assert.match(r.warning, /No Railway volume is attached/);
});

test("on Railway with the database inside the volume: volume, no warning", () => {
  for (const [mount, db] of [
    ["/data", "/data/history.db"],
    ["/data/", "/data/history.db"],
    ["/data", "/data/stellar-scope/history.db"],
  ]) {
    assert.deepEqual(
      describeStorage(db, { ...RAILWAY, RAILWAY_VOLUME_MOUNT_PATH: mount }),
      { storage: "volume", warning: null },
      `${mount} + ${db}`
    );
  }
});

test("on Railway with a volume the database is not in: ephemeral, and the warning names the mount", () => {
  for (const db of ["/app/prototype/data/history.db", "/data2/history.db", "/data"]) {
    const r = describeStorage(db, { ...RAILWAY, RAILWAY_VOLUME_MOUNT_PATH: "/data" });
    assert.equal(r.storage, "ephemeral", db);
    assert.match(r.warning, /attached at \/data, but the database is not inside it/, db);
  }
});

test("/api/health reports where the database lives, as a word, not a path", async () => {
  const res = await request(app, "GET", "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.historyDb.storage, "local");
  assert.ok(!/\.db|\/data\/|\/app\//.test(JSON.stringify(res.body.historyDb)), "historyDb leaks a path");
});
