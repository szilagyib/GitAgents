import type { TelemetrySink } from "../telemetry.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiProvider } from "./openai.js";
import { LlmClient } from "./client.js";
import type { LlmProvider, LlmProviderId } from "./provider.js";
import type { ModelPricing, ModelPricingOverride } from "./pricing.js";

const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";

export interface LlmConfig {
  provider: LlmProviderId;
  apiKey: string;
  model: string;
  baseURL?: string;
  pricingOverride?: ModelPricingOverride;
}

type Env = Record<string, string | undefined>;

/** Resolves LLM configuration from environment variables. */
export function resolveLlmConfig(env: Env): LlmConfig {
  const provider = resolveProvider(env.GITAGENTS_PROVIDER);
  const apiKey = resolveApiKey(env, provider);
  const model = resolveModel(env.GITAGENTS_MODEL, provider);
  const baseURL = env.GITAGENTS_BASE_URL || undefined;
  const pricingOverride = parsePricingOverride(env.GITAGENTS_MODEL_PRICING);
  return { provider, apiKey, model, baseURL, pricingOverride };
}

/** Builds the provider adapter for a resolved config. */
export function createLlmProvider(config: LlmConfig): LlmProvider {
  const opts = { apiKey: config.apiKey, baseURL: config.baseURL };
  return config.provider === "openai"
    ? new OpenAiProvider(opts)
    : new AnthropicProvider(opts);
}

/** Resolves config from env and returns a fully wired client. */
export function createLlmClient(
  env: Env,
  opts: { telemetry?: TelemetrySink; runId?: string } = {},
): LlmClient {
  const config = resolveLlmConfig(env);
  return new LlmClient(createLlmProvider(config), {
    model: config.model,
    telemetry: opts.telemetry,
    runId: opts.runId,
    pricingOverride: config.pricingOverride,
  });
}

function resolveProvider(raw: string | undefined): LlmProviderId {
  const value = (raw || "anthropic").toLowerCase();
  if (value === "anthropic" || value === "openai") return value;
  throw new Error(
    `GITAGENTS_PROVIDER "${raw}" is not supported. Use "anthropic" or "openai".`,
  );
}

function resolveApiKey(env: Env, provider: LlmProviderId): string {
  const providerKey = provider === "openai" ? env.OPENAI_API_KEY : env.CLAUDE_API_KEY;
  const key = providerKey || env.GITAGENTS_LLM_API_KEY;
  if (key) return key;
  const expected = provider === "openai" ? "OPENAI_API_KEY" : "CLAUDE_API_KEY";
  throw new Error(
    `No API key found. Set ${expected} (or GITAGENTS_LLM_API_KEY) for the ${provider} provider.`,
  );
}

function resolveModel(raw: string | undefined, provider: LlmProviderId): string {
  if (raw) return raw;
  if (provider === "anthropic") return ANTHROPIC_DEFAULT_MODEL;
  throw new Error(`GITAGENTS_MODEL is required for the ${provider} provider.`);
}

function parsePricingOverride(raw: string | undefined): ModelPricingOverride | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GITAGENTS_MODEL_PRICING is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GITAGENTS_MODEL_PRICING must be a JSON object of model → pricing.");
  }
  return parsed as Record<string, ModelPricing>;
}
