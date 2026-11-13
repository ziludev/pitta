import assert from "node:assert/strict";
import test from "node:test";
import { settle } from "../src/settle.ts";

test("a settle writes once", async () => {
  let writes = 0;
  await settle("app.test", async () => {
    writes += 1;
  });
  assert.equal(writes, 1);
});

/**
 * The Session refuses the second terminal write, and that refusal is the normal outcome of an abort
 * racing a finishing phase. It must not reach the task's error reports.
 */
test("losing the race to another terminal write is not an error", async () => {
  await settle("app.test", async () => {
    throw new Error("Task 42 is terminal");
  });
  await settle("app.test", async () => {
    throw new Error("Task 42 is abort-marked");
  });
  await settle("app.test", async () => {
    throw new Error("Session is closed");
  });
});

test("a real failure still throws", async () => {
  await assert.rejects(
    settle("app.test", async () => {
      throw new Error("disk is full");
    }),
    /disk is full/,
  );
});
