import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { compareUrl, remoteInfo } from "../src/git-info.ts";

const run = promisify(execFile);

/** Push finishes with a link; if the URL shape is wrong the button opens a 404. */
async function withRemote(url: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-remote-"));
  await run("git", ["init", "-q"], { cwd: dir });
  await run("git", ["remote", "add", "origin", url], { cwd: dir });
  return dir;
}

test("an ssh GitHub remote becomes an https compare link", async () => {
  const remote = await remoteInfo(await withRemote("git@github.com:ziludev/demo.git"));
  assert.equal(remote.kind, "github");
  assert.equal(remote.webUrl, "https://github.com/ziludev/demo");
  assert.equal(compareUrl(remote, "main", "agent/conv-7"), "https://github.com/ziludev/demo/compare/main...agent/conv-7?expand=1");
});

test("a GitLab ssh remote becomes a new-MR link with both branches", async () => {
  const remote = await remoteInfo(await withRemote("git@gitlab.example.com:team/example-service.git"));
  assert.equal(remote.kind, "gitlab");
  const url = compareUrl(remote, "master", "agent/conv-3");
  assert.match(url ?? "", /\/-\/merge_requests\/new\?/);
  assert.match(url ?? "", /source_branch\]=agent\/conv-3/);
  assert.match(url ?? "", /target_branch\]=master/);
});

test("an ssh:// remote is normalised the same way", async () => {
  const remote = await remoteInfo(await withRemote("ssh://git@github.com/ziludev/demo.git"));
  assert.equal(remote.webUrl, "https://github.com/ziludev/demo");
});

test("no remote means no link", async () => {
  const remote = await remoteInfo(await withRemote("https://example.invalid/none"));
  assert.equal(remote.kind, "other");
  assert.equal(compareUrl(remote, "main", "agent/conv-1"), undefined);

  const bare = await mkdtemp(join(tmpdir(), "agent-bare-"));
  await run("git", ["init", "-q"], { cwd: bare });
  const none = await remoteInfo(bare);
  assert.equal(none.kind, "none");
  assert.equal(compareUrl(none, "main", "b"), undefined);
});
