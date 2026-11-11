import {
  createCodemodeTool,
  type CodemodeToolOptions,
} from "@earendil-works/pi-durable/codemode";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { defineExtension, section, type ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Code mode: one request runs a script that calls several tools, which is the answer to the step
 * limit — a loop over twenty ids is one turn instead of twenty.
 *
 * The tool is deferred like the other rare ones, so its schema costs nothing until a request needs
 * it: `tool_search` loads it, and the section below tells the model it exists and what a script may
 * call. Nested calls are their own tool tasks, so the guard hook still sees them and a script
 * cannot reach `rm -rf` or the owner's Feishu identity without the same checks.
 */
const sandbox = new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() });

const codemodeTool = createCodemodeTool({
  sandbox,
  // Scripts get `tools.*`; the model catalog (`models.*`) is another surface we do not need.
  models: false,
} satisfies CodemodeToolOptions);

/** Named in the deferred list, and loadable on demand. */
export const CODEMODE_TOOL = { ...codemodeTool, deferred: true } as ToolRegistration;

const hint = section("codemode_hint", () => {
  return [
    "需要一次做很多步（同一条命令换几十个参数、遍历一批 id、先查再筛再汇总）时，用 `codemode`：",
    "写一段 JS，脚本里直接 `await tools.bash({ command: \"…\" })`、`await tools.read({ path })` 这样调用工具，",
    "一轮就能跑完。它默认不加载：先 `tool_search` 搜 `codemode`（名字就是它）。",
  ].join("\n");
});

export const codemodeExtension = defineExtension({
  name: "codemode",
  tools: [CODEMODE_TOOL],
  sections: [hint],
});
