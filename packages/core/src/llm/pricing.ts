import type { LlmProviderId } from "./provider.js";

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

/** Per-model price override, keyed by exact model id. */
export type ModelPricingOverride = Record<string, ModelPricing>;

const ZERO: ModelPricing = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  cacheWritePerMillion: 0,
  cacheReadPerMillion: 0,
};

/**
 * Best-effort pricing: an exact-model override wins; otherwise built-in tables
 * for Anthropic and common OpenAI models. Unknown models return zero pricing, so
 * their tokens are still tracked but cost as $0 rather than being mispriced.
 */
export function getModelPricing(
  provider: LlmProviderId,
  model: string,
  override?: ModelPricingOverride,
): ModelPricing {
  if (override && override[model]) return { ...override[model] };
  if (provider === "anthropic") return anthropicPricing(model);
  if (provider === "openai") return openAiPricing(model);
  return { ...ZERO };
}

function anthropicPricing(model: string): ModelPricing {
  const n = model.toLowerCase();

  if (n.includes("haiku-3-5") || n.includes("haiku-3.5")) {
    return { inputPerMillion: 0.8, outputPerMillion: 4, cacheWritePerMillion: 1, cacheReadPerMillion: 0.08 };
  }
  if (n.includes("haiku")) {
    return { inputPerMillion: 1, outputPerMillion: 5, cacheWritePerMillion: 1.25, cacheReadPerMillion: 0.1 };
  }
  if (
    n.includes("opus-4-7") || n.includes("opus-4.7") ||
    n.includes("opus-4-6") || n.includes("opus-4.6") ||
    n.includes("opus-4-5") || n.includes("opus-4.5")
  ) {
    return { inputPerMillion: 5, outputPerMillion: 25, cacheWritePerMillion: 6.25, cacheReadPerMillion: 0.5 };
  }
  if (n.includes("opus")) {
    return { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.5 };
  }
  // Sonnet / default.
  return { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.3 };
}

// OpenAI caches automatically (no write cost); cacheRead is the discounted input rate.
function openAiPricing(model: string): ModelPricing {
  const n = model.toLowerCase();

  if (n.includes("gpt-4.1-nano")) {
    return { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheWritePerMillion: 0, cacheReadPerMillion: 0.025 };
  }
  if (n.includes("gpt-4.1-mini")) {
    return { inputPerMillion: 0.4, outputPerMillion: 1.6, cacheWritePerMillion: 0, cacheReadPerMillion: 0.1 };
  }
  if (n.includes("gpt-4.1")) {
    return { inputPerMillion: 2, outputPerMillion: 8, cacheWritePerMillion: 0, cacheReadPerMillion: 0.5 };
  }
  if (n.includes("gpt-4o-mini")) {
    return { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheWritePerMillion: 0, cacheReadPerMillion: 0.075 };
  }
  if (n.includes("gpt-4o")) {
    return { inputPerMillion: 2.5, outputPerMillion: 10, cacheWritePerMillion: 0, cacheReadPerMillion: 1.25 };
  }
  return { ...ZERO };
}
