import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIError } from "@anthropic-ai/sdk/error";
import { AnthropicProvider } from "../../src/llm/anthropic";

let mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sdk")>();
  const MockAnthropic = vi.fn().mockImplementation(function () {
    return {
      messages: {
        get create() {
          return mockCreate;
        },
      },
    };
  });
  (MockAnthropic as unknown as Record<string, unknown>).APIError = actual.APIError;
  return { default: MockAnthropic, APIError: actual.APIError };
});

describe("AnthropicProvider.createMessage", () => {
  beforeEach(() => {
    mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 3,
      },
    });
  });

  it("maps cacheable system blocks and normalizes text, stop reason and usage", async () => {
    const provider = new AnthropicProvider({ apiKey: "k" });
    const res = await provider.createMessage({
      model: "claude-x",
      maxTokens: 100,
      system: [{ text: "A", cacheable: true }, { text: "B" }],
      messages: [{ role: "user", content: "hey" }],
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-x",
        max_tokens: 100,
        system: [
          { type: "text", text: "A", cache_control: { type: "ephemeral" } },
          { type: "text", text: "B" },
        ],
        messages: [{ role: "user", content: "hey" }],
      }),
      expect.objectContaining({ timeout: undefined }),
    );
    expect(res.text).toBe("hi");
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe("end");
    expect(res.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheWriteTokens: 5,
      cacheReadTokens: 3,
    });
  });

  it("maps tools to input_schema and surfaces tool calls with ids", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = new AnthropicProvider({ apiKey: "k" });
    const res = await provider.createMessage({
      model: "claude-x",
      maxTokens: 100,
      system: [{ text: "sys" }],
      messages: [{ role: "user", content: "q" }],
      tools: [{ name: "read_file", description: "d", parameters: { type: "object" } }],
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [{ name: "read_file", description: "d", input_schema: { type: "object" } }],
      }),
      expect.anything(),
    );
    expect(res.stopReason).toBe("tool_use");
    expect(res.text).toBe("thinking");
    expect(res.toolCalls).toEqual([{ id: "t1", name: "read_file", input: { path: "a.ts" } }]);
    expect(res.usage.cacheWriteTokens).toBe(0);
  });

  it("rebuilds assistant tool turns and coalesces tool results into one user message", async () => {
    const provider = new AnthropicProvider({ apiKey: "k" });
    await provider.createMessage({
      model: "claude-x",
      maxTokens: 100,
      system: [{ text: "sys" }],
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          text: "let me look",
          toolCalls: [
            { id: "t1", name: "read_file", input: { path: "a.ts" } },
            { id: "t2", name: "search_repo", input: { query: "foo" } },
          ],
        },
        { role: "tool_result", toolCallId: "t1", content: "file a" },
        { role: "tool_result", toolCallId: "t2", content: "hit" },
      ],
    });

    const sent = mockCreate.mock.calls[0][0].messages;
    expect(sent).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "t2", name: "search_repo", input: { query: "foo" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "file a" },
          { type: "tool_result", tool_use_id: "t2", content: "hit" },
        ],
      },
    ]);
  });

  it("classifies rate-limit, transient and network errors", () => {
    const provider = new AnthropicProvider({ apiKey: "k" });
    const rate = new APIError(429, undefined, "rate", undefined);
    const server = new APIError(503, undefined, "down", undefined);
    const client = new APIError(400, undefined, "bad", undefined);

    expect(provider.isRateLimitError(rate)).toBe(true);
    expect(provider.isTransientError(rate)).toBe(true);
    expect(provider.isTransientError(server)).toBe(true);
    expect(provider.isRateLimitError(server)).toBe(false);
    expect(provider.isTransientError(client)).toBe(false);
    expect(provider.isTransientError(new Error("ETIMEDOUT while connecting"))).toBe(true);
  });
});
