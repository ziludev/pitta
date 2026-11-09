import { config } from "./config.ts";
import { openRuntime } from "./harness.ts";
import { startFeishuBridge } from "./feishu.ts";
import { startAgentServer } from "./server.ts";

const runtime = await openRuntime();
console.log(
  `[agent] model=${config.model.provider}/${config.model.modelId} workspace=${config.workspace} db=${config.dbPath}`,
);

// Local client bridge: the desktop app is just another watcher on the same storage.
const server = await startAgentServer(runtime);

const bridge = await startFeishuBridge(runtime);

// A storage error closes the harness for good; nothing works afterwards. Exit so
// launchd restarts a clean process instead of leaving a zombie serving errors.
void runtime.harness.closed.then((end) => {
  console.error(`[agent] harness closed: ${end.kind}`);
  bridge.stop();
  void server.close().catch(() => {});
  process.exit(end.kind === "failed" ? 1 : 0);
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`[agent] ${signal}, closing`);
  bridge.stop();
  await server.close().catch(() => {});
  try {
    // Waits for running task code to return, so in-flight turns settle cleanly.
    await runtime.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
