import { createProvider, createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { config } from "./config.ts";
import { log } from "./log.ts";

/**
 * The local magpie proxy speaks OpenAI chat completions on localhost.
 *
 * Its model list is asked of the gateway instead of being hard-coded: magpie is also where the
 * model is chosen (its Agent page writes AGENT_MODEL), so a model picked there has to work here
 * without a code change. The gateway reports context length, modalities and per-token pricing,
 * which is what the budget gate needs.
 */

/** The fields of one `/v1/models` entry this file maps. */
type GatewayModel = {
  id: string;
  display_name?: string;
  context_length?: number;
  max_output_tokens?: number;
  modalities?: { input?: string[] };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  reasoning?: boolean;
  reasoning_levels?: string[];
};

const PER_MILLION = 1_000_000;
const DEFAULT_CONTEXT = 1_000_000;
const DEFAULT_MAX_TOKENS = 393_216;

const toNumber = (raw: string | undefined): number | undefined => {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) ? value : undefined;
};

/** pi-ai wants prices per million tokens; the gateway gives them per token. */
function toModel(entry: GatewayModel, baseUrl: string) {
  const perMillion = (value: string | undefined): number => (toNumber(value) ?? 0) * PER_MILLION;
  const levels = entry.reasoning_levels ?? [];
  const thinking: Record<string, string> = {};
  for (const level of ["low", "medium", "high", "max"] as const) {
    if (levels.includes(level)) thinking[level] = level;
  }
  return {
    id: entry.id,
    name: entry.display_name ?? entry.id,
    api: "openai-completions" as const,
    provider: "magpie",
    baseUrl,
    input: (entry.modalities?.input ?? ["text"]).filter((kind): kind is "text" | "image" =>
      kind === "text" || kind === "image",
    ),
    cost: {
      input: perMillion(entry.pricing?.prompt),
      output: perMillion(entry.pricing?.completion),
      cacheRead: perMillion(entry.pricing?.input_cache_read),
      cacheWrite: 0,
    },
    reasoning: entry.reasoning === true,
    ...(Object.keys(thinking).length > 0 ? { thinkingLevelMap: thinking } : {}),
    contextWindow: entry.context_length ?? DEFAULT_CONTEXT,
    maxTokens: entry.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };
}

/** Used when the gateway cannot be reached at boot, so an offline start still knows one model. */
function fallback(modelId: string, baseUrl: string) {
  return toModel({ id: modelId, context_length: DEFAULT_CONTEXT, max_output_tokens: DEFAULT_MAX_TOKENS }, baseUrl);
}

async function discover(baseUrl: string, apiKey: string): Promise<GatewayModel[]> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) {
      log("models", "gateway model list refused", { status: response.status });
      return [];
    }
    const body = (await response.json()) as { data?: GatewayModel[] };
    return (body.data ?? []).filter((entry) => typeof entry?.id === "string" && entry.id.length > 0);
  } catch (error) {
    log("models", `could not list models from magpie, using the configured one: ${(error as Error).message}`);
    return [];
  }
}

async function magpieProvider() {
  const { baseUrl, apiKey } = config.magpie;
  const discovered = await discover(baseUrl, apiKey);
  const models = discovered.map((entry) => toModel(entry, baseUrl));
  // The configured model must exist even when the gateway did not list it (offline, renamed).
  if (!models.some((entry) => entry.id === config.model.modelId)) {
    models.push(fallback(config.model.modelId, baseUrl));
  }
  log("models", "magpie models", { count: models.length, configured: config.model.modelId });
  return createProvider({
    id: "magpie",
    name: "Magpie (local proxy)",
    baseUrl,
    auth: {
      apiKey: {
        name: "Magpie API key",
        resolve: async () => ({ auth: { apiKey }, source: "MAGPIE_API_KEY" }),
      },
    },
    models,
    api: openAICompletionsApi(),
  });
}

/** Built-in providers (openai, deepseek, anthropic, ...) plus the local magpie proxy. */
export async function createAgentModels(): Promise<MutableModels> {
  const models = createModels();
  for (const provider of builtinProviders()) models.setProvider(provider);
  models.setProvider(await magpieProvider());
  return models;
}

/**
 * `auto/*` and `group/*` are routing groups: the backend changes per request, so the
 * same prompt can behave differently run to run. Warn loudly instead of silently
 * shipping an unstable agent.
 */
export function warnIfRoutingGroup(): void {
  const { provider, modelId } = config.model;
  if (provider === "magpie" && (modelId.startsWith("auto/") || modelId.startsWith("group/"))) {
    console.warn(
      `[models] ${modelId} is a routing group: identical tasks may route to different models. ` +
        "Pin a concrete id (e.g. vendor/deepseek-flash) for stable behaviour.",
    );
  }
}

/** Fail fast with a readable message instead of a `no_model` run failure. */
export function assertModelAvailable(models: MutableModels): void {
  const { provider, modelId } = config.model;
  const model = models.getModel(provider, modelId);
  if (model === undefined) {
    const known = models
      .getModels(provider)
      .slice(0, 8)
      .map((entry) => entry.id)
      .join(", ");
    throw new Error(
      `model ${provider}/${modelId} not found; known ${provider} models: ${known || "<none>"}`,
    );
  }
}
