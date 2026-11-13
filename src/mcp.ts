import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import { log, logError } from "./log.ts";

export type McpServerConfig = {
  /** Prepended to every tool name as `mcp__<name>__<tool>`. */
  name: string;
  /** stdio server. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Streamable HTTP server; takes precedence over command. */
  url?: string;
  headers?: Record<string, string>;
};

export type McpRuntime = {
  extension: Extension | undefined;
  serverCount: number;
  toolCount: number;
  close(): Promise<void>;
};

function connectTransport(server: McpServerConfig, workspace: string) {
  if (server.url !== undefined) {
    return new StreamableHttpTransport({ url: server.url, headers: server.headers });
  }
  if (server.command === undefined) {
    throw new Error(`mcp server "${server.name}" needs either url or command`);
  }
  return new StdioTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...process.env, ...server.env } as Record<string, string>,
    cwd: workspace,
  });
}

function toolName(server: string, tool: string): string {
  const safe = `${server}__${tool}`.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp__${safe}`.slice(0, 64);
}

/**
 * Connects the configured MCP servers and exposes their tools as durable tool tasks.
 * Tools default to `replay: "unsafe"`: an interrupted call is reported to the model
 * instead of being silently repeated against some external system.
 */
export async function connectMcp(configPath: string, workspace: string): Promise<McpRuntime> {
  if (!existsSync(configPath)) {
    return { extension: undefined, serverCount: 0, toolCount: 0, close: async () => {} };
  }

  let servers: McpServerConfig[] = [];
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as
      | { servers?: Record<string, Omit<McpServerConfig, "name">> }
      | McpServerConfig[];
    servers = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed.servers ?? {}).map(([name, config]) => ({ name, ...config }));
  } catch (error) {
    logError("mcp", `could not read ${configPath}`, error);
    return { extension: undefined, serverCount: 0, toolCount: 0, close: async () => {} };
  }

  const clients: Array<{ client: McpClient; name: string }> = [];
  const tools: ToolRegistration[] = [];

  for (const server of servers) {
    const client = new McpClient({ name: "pitta", version: "0.1.0", roots: [{ uri: `file://${workspace}`, name: "workspace" }] });
    try {
      await client.connect(connectTransport(server, workspace));
      type ListedTool = { name: string; description?: string; inputSchema?: object };
      const listed = (await client.listTools()) as unknown as ListedTool[] | { tools?: ListedTool[] };
      // pi-mcp returns the tool array itself; tolerate the spec's { tools } shape too.
      const toolList = Array.isArray(listed) ? listed : (listed.tools ?? []);
      for (const tool of toolList) {
        const name = toolName(server.name, tool.name);
        tools.push(
          defineTool({
            name,
            description: `[${server.name}] ${tool.description ?? tool.name}`,
            // MCP schemas are plain JSON Schema; the harness validates against them as-is.
            parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as object,
            execute: async (args) => {
              try {
                const result = await client.callTool(tool.name, args as Record<string, unknown>);
                return {
                  output: toLlmContent(result) as never,
                  isError: result.isError === true ? true : undefined,
                  details: { server: server.name, tool: tool.name } as never,
                };
              } catch (error) {
                return {
                  output: [{ type: "text" as const, text: `MCP 调用失败：${(error as Error).message}` }],
                  isError: true,
                };
              }
            },
          }),
        );
      }
      clients.push({ client, name: server.name });
      log("mcp", `connected ${server.name}`, { tools: toolList.length });
    } catch (error) {
      logError("mcp", `could not connect ${server.name}`, error);
      await client.close().catch(() => {});
    }
  }

  if (tools.length === 0) {
    return { extension: undefined, serverCount: clients.length, toolCount: 0, close: async () => {
      for (const { client } of clients) await client.close().catch(() => {});
    } };
  }

  return {
    extension: defineExtension({ name: "mcp", tools }),
    serverCount: clients.length,
    toolCount: tools.length,
    close: async () => {
      for (const { client } of clients) await client.close().catch(() => {});
    },
  };
}
