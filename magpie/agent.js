/**
 * Magpie agent plugin for the Pi Durable Agent.
 *
 * Magpie runs every agent's model choice through its gateway on 127.0.0.1:3425 and writes the
 * result into that agent's own settings file. This agent keeps its settings in `.env` beside the
 * repository (it reads them once at startup), so the plugin says where that file is, which key
 * holds the model, and which keys point the agent at the gateway.
 *
 * The model is a magpie id (`<provider>/<model>`), exactly what `AGENT_MODEL` takes; the agent
 * asks the gateway for its model list at boot, so anything pickable here works there.
 */

// Plugin code runs without `process` (magpie loads it in its own host), so the path is written
// out rather than read from the environment. The CLI and the launchd service both default here;
// edit this line when the repository lives somewhere else.
const home = "~/learn/pi-durable-agent";

export const agent = {
  id: "pi-durable",
  name: "Pi Durable Agent",
  bin: "durable",
  config: `${home}/.env`,
  format: "env",
  // The `.env` key the model id goes into. A magpie id is already `<provider>/<model>`.
  model: "AGENT_MODEL",
  notice: "Agent 只在启动时读 .env：换完模型要重启（./scripts/agentctl restart，或桌面端左栏「重启」）。",
};

/** Written beside the model: which provider to use and where the gateway is. */
export function connect({ gateway }) {
  return {
    AGENT_PROVIDER: "magpie",
    MAGPIE_BASE_URL: gateway.v1,
    MAGPIE_API_KEY: gateway.key,
  };
}
