import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { collectChanges, commitChanges, ensureRepo } from "../src/changes.ts";

const run = promisify(execFile);

/** The Changes panel reads this: a wrong status or count shows the wrong diff. */
async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-changes-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@local"], { cwd: dir });
  await run("git", ["config", "user.name", "test"], { cwd: dir });
  await writeFile(join(dir, "kept.txt"), "one\ntwo\n");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("ensureRepo reports \"is a repo\", not \"had to create one\"", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-repo-"));
  // The flag says the directory is usable as a repo; both calls must agree, because the
  // caller uses it to decide whether the Changes panel has anything to show.
  assert.equal(await ensureRepo(dir), true);
  assert.equal(await ensureRepo(dir), true);
  await writeFile(join(dir, "x.txt"), "x\n");
  const snapshot = await collectChanges(dir);
  assert.equal(snapshot.files[0]?.path, "x.txt");
});

test("collectChanges separates untracked from modified and counts lines", async () => {
  const dir = await scratchRepo();
  await writeFile(join(dir, "kept.txt"), "one\ntwo\nthree\n");
  await writeFile(join(dir, "fresh.txt"), "hello\n");

  const snapshot = await collectChanges(dir);
  const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
  assert.equal(byPath.get("fresh.txt")?.status, "untracked");
  assert.equal(byPath.get("kept.txt")?.status, "modified");
  assert.equal(byPath.get("kept.txt")?.added, 1);
  assert.equal(byPath.get("kept.txt")?.removed, 0);
  assert.match(snapshot.diff, /\+three/);
});

test("a clean tree has no files", async () => {
  const dir = await scratchRepo();
  const snapshot = await collectChanges(dir);
  assert.deepEqual(snapshot.files, []);
  assert.equal(snapshot.diff.trim(), "");
});

test("commitChanges commits everything and returns the new head", async () => {
  const dir = await scratchRepo();
  await writeFile(join(dir, "new.txt"), "x\n");
  const head = await commitChanges(dir, "test: add new.txt");
  assert.match(head, /^[0-9a-f]{7,40}$/);
  assert.deepEqual((await collectChanges(dir)).files, []);
  const log = await run("git", ["log", "-1", "--pretty=%s"], { cwd: dir });
  assert.equal(log.stdout.trim(), "test: add new.txt");
});
