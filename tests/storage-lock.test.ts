import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireStorageLock, looksLikeAgent } from "../src/storage-lock.ts";

function dbDir(): string {
  return join(mkdtempSync(join(tmpdir(), "lock-")), "agent.sqlite");
}

test("a free storage is taken", () => {
  const db = dbDir();
  acquireStorageLock(db);
  assert.equal(readFileSync(join(db, "..", "agent.owner"), "utf8").trim(), String(process.pid));
});

/** The reboot case: the recorded pid is alive but belongs to something else now. */
test("a recycled pid does not block startup", () => {
  const db = dbDir();
  writeFileSync(join(db, "..", "agent.owner"), "1", "utf8");
  acquireStorageLock(db);
  assert.equal(readFileSync(join(db, "..", "agent.owner"), "utf8").trim(), String(process.pid));
});

test("a second live agent in the same storage is refused", async () => {
  const db = dbDir();
  // An "agent" from the outside: a node process whose command line mentions main.ts.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "src/main.ts"], {
    stdio: "ignore",
  });
  await new Promise((done) => setTimeout(done, 150));
  writeFileSync(join(db, "..", "agent.owner"), String(child.pid), "utf8");
  assert.throws(() => acquireStorageLock(db), /is owned by pid \d+ \(a running agent\)/);
  child.kill();
});

test("only a node command naming main.ts looks like an agent", () => {
  assert.equal(looksLikeAgent("/opt/node/bin/node /app/src/main.ts"), true);
  assert.equal(looksLikeAgent("/sbin/launchd"), false);
  assert.equal(looksLikeAgent("node /app/src/server.ts"), false);
});
