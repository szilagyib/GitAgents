import { describe, it, expect } from "vitest";
import { getModelPricing } from "../../src/llm/pricing";

describe("getModelPricing", () => {
  it("prices Anthropic Sonnet with the default table", () => {
    expect(getModelPricing("anthropic", "claude-sonnet-4-6")).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheWritePerMillion: 3.75,
      cacheReadPerMillion: 0.3,
    });
  });

  it("prices Anthropic Haiku and Opus tiers", () => {
    expect(getModelPricing("anthropic", "claude-haiku-4-5").outputPerMillion).toBe(5);
    expect(getModelPricing("anthropic", "claude-opus-4-6").inputPerMillion).toBe(5);
  });

  it("prices common OpenAI models", () => {
    expect(getModelPricing("openai", "gpt-4o")).toEqual({
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      cacheWritePerMillion: 0,
      cacheReadPerMillion: 1.25,
    });
    expect(getModelPricing("openai", "gpt-4o-mini").inputPerMillion).toBe(0.15);
    expect(getModelPricing("openai", "gpt-4.1").outputPerMillion).toBe(8);
  });

  it("returns zero pricing for unknown models so tokens still track at cost 0", () => {
    expect(getModelPricing("openai", "some-local-model")).toEqual({
      inputPerMillion: 0,
      outputPerMillion: 0,
      cacheWritePerMillion: 0,
      cacheReadPerMillion: 0,
    });
  });

  it("applies a per-model override before the built-in tables", () => {
    const override = {
      "gpt-4o": {
        inputPerMillion: 1,
        outputPerMillion: 2,
        cacheWritePerMillion: 0,
        cacheReadPerMillion: 0.5,
      },
    };
    expect(getModelPricing("openai", "gpt-4o", override)).toEqual(override["gpt-4o"]);
  });
});
