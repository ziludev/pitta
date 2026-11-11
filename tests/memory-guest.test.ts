import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatMemory, GlobalMemory, WorkMemory, memoryTools, type Note } from "../src/memory.ts";
import { ChatPolicy } from "../src/guest.ts";

/**
 * A guest conversation is a shared group opened with /allow or /open. It must not see the
 * owner's memories, and it must not delete them either. The prompt section and `remember`
 * were gated from the start; `recall` and `forget` were not, so anyone in an opened group
 * could ask for a note by keyword — or wipe every note that matched one.
 */

type Notes = { global: Note[]; chat: Note[]; work: Note[] };

function note(text: string): Note {
  return { at: "2026-11-11T00:00:00.000Z", text };
}

/** Just enough of the tool api: the three memory documents plus the chat policy. */
function fakeApi(notes: Notes, guest: boolean) {
  const docOf = (doc: unknown): { notes: Note[] } => {
    if (doc === GlobalMemory) return { notes: notes.global };
    if (doc === ChatMemory) return { notes: notes.chat };
    if (doc === WorkMemory) return { notes: notes.work };
    throw new Error("unexpected doc");
  };
  return {
    conversationId: 1,
    snapshot: async (doc: unknown) => (doc === ChatPolicy ? { guest } : docOf(doc)),
    commit: async (body: (tx: { doc: (doc: unknown) => { notes: Note[] } }) => Promise<void>) => {
      await body({ doc: docOf });
    },
  };
}

type Tool = {
  name: string;
  execute: (
    args: Record<string, unknown>,
    api: never,
    context: never,
  ) => Promise<{ output: Array<{ text: string }> }>;
};

function tool(name: string): Tool {
  const found = memoryTools.find((candidate) => candidate.name === name);
  assert.ok(found !== undefined, `tool ${name} exists`);
  return found as unknown as Tool;
}

function seeded(): Notes {
  return {
    global: [note("项目代号金刚狼")],
    chat: [note("本群在改项目 X")],
    work: [note("项目部署在 dev 命名空间")],
  };
}

async function recallText(notes: Notes, guest: boolean, query: string): Promise<string> {
  const result = await tool("recall").execute({ query }, fakeApi(notes, guest) as never, {} as never);
  return result.output[0]?.text ?? "";
}

test("a guest conversation recalls its own notes only", async () => {
  const text = await recallText(seeded(), true, "项目");
  assert.match(text, /本群在改项目 X/);
  assert.doesNotMatch(text, /金刚狼/, "global memory must not leak into a shared group");
  assert.doesNotMatch(text, /dev 命名空间/, "work memory must not leak into a shared group");
  assert.doesNotMatch(text, /\[全局\]|\[工作\]/);
});

test("the owner still recalls every scope", async () => {
  const text = await recallText(seeded(), false, "项目");
  assert.match(text, /\[全局\].*金刚狼/);
  assert.match(text, /\[本对话\].*项目 X/);
  assert.match(text, /\[工作\].*dev 命名空间/);
});

test("a guest conversation cannot delete the owner's notes", async () => {
  const notes = seeded();
  await tool("forget").execute({ keyword: "项目" }, fakeApi(notes, true) as never, {} as never);
  assert.equal(notes.chat.length, 0, "the group's own note is the one it may remove");
  assert.deepEqual(
    notes.global.map((entry) => entry.text),
    ["项目代号金刚狼"],
  );
  assert.deepEqual(
    notes.work.map((entry) => entry.text),
    ["项目部署在 dev 命名空间"],
  );
});

test("the owner can still forget across every scope", async () => {
  const notes = seeded();
  await tool("forget").execute({ keyword: "项目" }, fakeApi(notes, false) as never, {} as never);
  assert.equal(notes.global.length + notes.chat.length + notes.work.length, 0);
});
