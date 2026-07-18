import { describe, it, expect } from "vitest";
import { resolveLlmConfig, createLlmProvider } from "../../src/llm/config";

describe("resolveLlmConfig", () => {
  it("defaults to Anthropic with the CLAUDE_API_KEY and default model", () => {
    expect(resolveLlmConfig({ CLAUDE_API_KEY: "k" })).toEqual({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-sonnet-4-6",
      baseURL: undefined,
      pricingOverride: undefined,
    });
  });

  it("resolves OpenAI with its key and explicit model", () => {
    const cfg = resolveLlmConfig({
      GITAGENTS_PROVIDER: "openai",
      OPENAI_API_KEY: "o",
      GITAGENTS_MODEL: "gpt-4o",
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.apiKey).toBe("o");
    expect(cfg.model).toBe("gpt-4o");
  });

  it("requires a model for OpenAI", () => {
    expect(() =>
      resolveLlmConfig({ GITAGENTS_PROVIDER: "openai", OPENAI_API_KEY: "o" }),
    ).toThrow(/GITAGENTS_MODEL/);
  });

  it("falls back to the generic GITAGENTS_LLM_API_KEY", () => {
    const cfg = resolveLlmConfig({
      GITAGENTS_PROVIDER: "openai",
      GITAGENTS_LLM_API_KEY: "g",
      GITAGENTS_MODEL: "gpt-4o",
    });
    expect(cfg.apiKey).toBe("g");
  });

  it("throws a clear error when the API key is missing", () => {
    expect(() => resolveLlmConfig({})).toThrow(/CLAUDE_API_KEY/);
  });

  it("rejects an unknown provider", () => {
    expect(() => resolveLlmConfig({ GITAGENTS_PROVIDER: "gemini" })).toThrow(/GITAGENTS_PROVIDER/);
  });

  it("parses base URL and a model pricing override", () => {
    const cfg = resolveLlmConfig({
      CLAUDE_API_KEY: "k",
      GITAGENTS_BASE_URL: "https://gw.example/v1",
      GITAGENTS_MODEL_PRICING:
        '{"m":{"inputPerMillion":1,"outputPerMillion":2,"cacheWritePerMillion":0,"cacheReadPerMillion":0.5}}',
    });
    expect(cfg.baseURL).toBe("https://gw.example/v1");
    expect(cfg.pricingOverride).toEqual({
      m: { inputPerMillion: 1, outputPerMillion: 2, cacheWritePerMillion: 0, cacheReadPerMillion: 0.5 },
    });
  });

  it("rejects invalid pricing override JSON", () => {
    expect(() =>
      resolveLlmConfig({ CLAUDE_API_KEY: "k", GITAGENTS_MODEL_PRICING: "{not json" }),
    ).toThrow(/GITAGENTS_MODEL_PRICING/);
  });
});

describe("createLlmProvider", () => {
  it("builds the Anthropic provider", () => {
    expect(createLlmProvider({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-4-6" }).id).toBe(
      "anthropic",
    );
  });

  it("builds the OpenAI provider", () => {
    expect(createLlmProvider({ provider: "openai", apiKey: "o", model: "gpt-4o" }).id).toBe("openai");
  });
});
