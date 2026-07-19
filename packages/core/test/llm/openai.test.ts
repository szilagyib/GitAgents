import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIError } from "openai";
import { OpenAiProvider } from "../../src/llm/openai";

let mockCreate = vi.fn();

vi.mock("openai", async (importActual) => {
  const actual = await importActual<typeof import("openai")>();
  const MockOpenAI = vi.fn().mockImplementation(function () {
    return {
      chat: {
        completions: {
          get create() {
            return mockCreate;
          },
        },
      },
    };
  });
  (MockOpenAI as unknown as Record<string, unknown>).APIError = actual.APIError;
  return { default: MockOpenAI, APIError: actual.APIError };
});

describe("OpenAiProvider.createMessage", () => {
  beforeEach(() => {
    mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    });
  });

  it("sends one system message + max_completion_tokens (no max_tokens/temperature) and subtracts cached tokens", async () => {
    const provider = new OpenAiProvider({ apiKey: "k" });
    const res = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 100,
      system: [{ text: "A", cacheable: true }, { text: "B" }],
      messages: [{ role: "user", content: "hey" }],
    });

    const arg = mockCreate.mock.calls[0][0];
    expect(arg.model).toBe("gpt-4o");
    expect(arg.max_completion_tokens).toBe(100);
    expect(arg.max_tokens).toBeUndefined();
    expect(arg.temperature).toBeUndefined();
    expect(arg.messages).toEqual([
      { role: "system", content: "A\n\nB" },
      { role: "user", content: "hey" },
    ]);

    expect(res.text).toBe("hello");
    expect(res.stopReason).toBe("end");
    expect(res.usage).toEqual({
      inputTokens: 70, // prompt_tokens (100) - cached (30)
      outputTokens: 20,
      cacheWriteTokens: 0,
      cacheReadTokens: 30,
    });
  });

  it("parses tool-call arguments from a JSON string and maps finish_reason=tool_calls", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });

    const provider = new OpenAiProvider({ apiKey: "k" });
    const res = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 100,
      system: [{ text: "sys" }],
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "read_file", description: "d", parameters: { type: "object" } }],
    });

    expect(mockCreate.mock.calls[0][0].tools).toEqual([
      { type: "function", function: { name: "read_file", description: "d", parameters: { type: "object" } } },
    ]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.text).toBe("");
    expect(res.toolCalls).toEqual([{ id: "c1", name: "read_file", input: { path: "a.ts" } }]);
    expect(res.usage.cacheReadTokens).toBe(0);
  });

  it("maps assistant tool turns and tool_result into assistant.tool_calls and tool-role messages", async () => {
    const provider = new OpenAiProvider({ apiKey: "k" });
    await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 100,
      system: [{ text: "sys" }],
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          text: "look",
          toolCalls: [{ id: "c1", name: "read_file", input: { path: "a.ts" } }],
        },
        { role: "tool_result", toolCallId: "c1", content: "file a" },
      ],
    });

    expect(mockCreate.mock.calls[0][0].messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "look",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "file a" },
    ]);
  });

  it("maps finish_reason=length to max_tokens", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "truncated" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = new OpenAiProvider({ apiKey: "k" });
    const res = await provider.createMessage({
      model: "gpt-4o",
      maxTokens: 5,
      system: [{ text: "sys" }],
      messages: [{ role: "user", content: "q" }],
    });
    expect(res.stopReason).toBe("max_tokens");
  });

  it("classifies rate-limit, transient and network errors", () => {
    const provider = new OpenAiProvider({ apiKey: "k" });
    const rate = new APIError(429, undefined, "rate", undefined);
    const server = new APIError(503, undefined, "down", undefined);
    const client = new APIError(400, undefined, "bad", undefined);

    expect(provider.isRateLimitError(rate)).toBe(true);
    expect(provider.isTransientError(rate)).toBe(true);
    expect(provider.isTransientError(server)).toBe(true);
    expect(provider.isRateLimitError(server)).toBe(false);
    expect(provider.isTransientError(client)).toBe(false);
    expect(provider.isTransientError(new Error("ECONNRESET"))).toBe(true);
  });
});
