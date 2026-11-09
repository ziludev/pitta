import { createProvider, createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { config } from "./config.ts";

/**
 * The local magpie proxy speaks OpenAI chat completions on localhost.
 * Registered as a normal provider so the rest of the harness stays model-agnostic.
 */
function magpieProvider() {
  const { baseUrl, apiKey } = config.magpie;
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
    models: [
      {
        id: "auto/deepseek-flash",
        name: "DeepSeek Flash (magpie)",
        api: "openai-completions",
        provider: "magpie",
        baseUrl,
        input: ["text", "image"],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
        reasoning: true,
        thinkingLevelMap: { low: "low", high: "high", max: "max" },
        contextWindow: 1_048_576,
        maxTokens: 393_216,
      },
      {
        id: "auto/glm-5.3",
        name: "GLM-5.3 (magpie)",
        api: "openai-completions",
        provider: "magpie",
        baseUrl,
        input: ["text"],
        cost: { input: 1.19, output: 4.18, cacheRead: 0.29, cacheWrite: 0 },
        reasoning: true,
        thinkingLevelMap: { low: "low", high: "high", max: "max" },
        contextWindow: 1_000_000,
        maxTokens: 131_072,
      },
      {
        id: "vendor/deepseek-flash",
        name: "DeepSeek Flash (magpie, team route)",
        api: "openai-completions",
        provider: "magpie",
        baseUrl,
        input: ["text", "image"],
        cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
        reasoning: true,
        thinkingLevelMap: { low: "low", high: "high", max: "max" },
        contextWindow: 1_048_576,
        maxTokens: 393_216,
      },
    ],
    api: openAICompletionsApi(),
  });
}

/** Built-in providers (openai, deepseek, anthropic, ...) plus the local magpie proxy. */
export function createAgentModels(): MutableModels {
  const models = createModels();
  for (const provider of builtinProviders()) models.setProvider(provider);
  models.setProvider(magpieProvider());
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
