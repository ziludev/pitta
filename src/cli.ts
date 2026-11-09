/**
 * Local smoke test: same harness, no Feishu. Useful to check model/tools before wiring the bot.
 *   npm run ask -- "你好，帮我看看 workspace 里有什么"
 *   npm run ask -- --reset "换个话题"
 */
import { createInterface } from "node:readline/promises";
import { context, openRuntime } from "./harness.ts";
import { watchLive } from "./live.ts";
import { setApprovalDecider, setNotifier } from "./channel.ts";

const args = process.argv.slice(2);
const reset = args[0] === "--reset";
const prompt = (reset ? args.slice(1) : args).join(" ").trim();
if (prompt.length === 0) {
  console.error('usage: node src/cli.ts [--reset] "your message"');
  process.exit(2);
}

// CLI stand-ins for the Feishu side: deliver reminders to stdout, ask approvals on stdin.
setNotifier(async (surfaceId, text) => console.log(`\n[notify → ${surfaceId}] ${text}`));
if (process.stdin.isTTY) {
  setApprovalDecider(async (request) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        `\n⚠️  需要确认：${request.tool} — ${request.reason}\n${request.summary.slice(0, 800)}\n允许? (y/N) `,
      );
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  });
}

const runtime = await openRuntime();
const conversation = await runtime.conversationFor(process.env.AGENT_SURFACE ?? "cli");
if (reset) await conversation.reset(undefined, context);

let lastTools = "";
const watcher = await watchLive(conversation, (live) => {
  const line = live.tools.join(" · ");
  if (line !== lastTools) {
    lastTools = line;
    if (line.length > 0) console.log(`  ⚙️  ${line}`);
  }
});

const startedAt = Date.now();
const submission = await conversation.submit(
  { type: "input", content: prompt, requestId: `cli:${Date.now()}` },
  context,
);
const settled = await submission.wait(context);
await watcher.stop();

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (settled.status === "done" && settled.answer !== undefined) {
  console.log(`\n${await runtime.answerText(conversation, settled.answer)}\n`);
  console.log(`— ${seconds}s, conversation ${conversation.id}`);
} else {
  console.error(`\n✗ unanswered: ${settled.reason ?? "unknown"}`);
  if (settled.detail !== undefined) console.error(String(settled.detail));
}

await runtime.close();
