import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIError } from "@anthropic-ai/sdk/error";
import { ClaudeClient, RateLimitError } from "../../src/claude/client";

// Capture reference to mock create so tests can override it
let mockCreate = vi.fn().mockResolvedValue({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        findings: [
          {
            line: 5,
            severity: "error",
            confidence: "high",
            ruleId: "null-safety",
            autoFixable: true,
            message: "Null dereference",
            codeContext: "user.getName()",
            suggestedApproach: "Add null check",
          },
        ],
        summary: "1 error found.",
      }),
    },
  ],
});

vi.mock("@anthropic-ai/sdk", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sdk")>();
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      get create() {
        return mockCreate;
      },
    },
  }));
  // Expose real APIError so instanceof checks in client.ts work correctly
  (MockAnthropic as unknown as Record<string, unknown>).APIError = actual.APIError;
  return { default: MockAnthropic, APIError: actual.APIError };
});

describe("ClaudeClient", () => {
  beforeEach(() => {
    mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            findings: [
              {
                line: 5,
                severity: "error",
                confidence: "high",
                ruleId: "null-safety",
                autoFixable: true,
                message: "Null dereference",
                codeContext: "user.getName()",
                suggestedApproach: "Add null check",
              },
            ],
            summary: "1 error found.",
          }),
        },
      ],
    });
  });

  it("sends review request and parses structured response", async () => {
    const client = new ClaudeClient("fake-key");
    const response = await client.review({
      systemPrompt: "You are a reviewer",
      userPrompt: "Review this diff",
      maxTokens: 4096,
      timeoutMs: 60000,
    });

    expect(response.findings).toHaveLength(1);
    expect(response.findings[0].ruleId).toBe("null-safety");
    expect(response.summary).toBe("1 error found.");
  });

  it("sends cacheable system prompt blocks to Claude", async () => {
    const client = new ClaudeClient("fake-key");
    await client.review({
      systemPrompt: [
        { text: "Stable review methodology", cacheable: true },
        { text: "Rules for this file" },
      ],
      userPrompt: "Review this diff",
      maxTokens: 4096,
      timeoutMs: 60000,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        system: [
          {
            type: "text",
            text: "Stable review methodology",
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: "Rules for this file",
          },
        ],
      }),
      expect.anything(),
    );
  });

  it("returns empty findings and raw text when Claude returns invalid JSON", async () => {
    const rawText = "This is not JSON at all";
    mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: rawText }],
    });

    const client = new ClaudeClient("fake-key");
    const response = await client.review({
      systemPrompt: "You are a reviewer",
      userPrompt: "Review this diff",
      maxTokens: 4096,
      timeoutMs: 60000,
    });

    expect(response.findings).toHaveLength(0);
    expect(response.summary).toBe(rawText);
  });

  it("keeps findings when Claude returns an unknown optional fix strategy", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            findings: [
              {
                line: 5,
                severity: "error",
                confidence: "high",
                ruleId: "null-safety",
                autoFixable: true,
                fixStrategy: "invent-enterprise-platform",
                message: "Null dereference",
                codeContext: "user.getName()",
                suggestedApproach: "Add null check",
              },
            ],
            summary: "1 error found.",
          }),
        },
      ],
    });

    const client = new ClaudeClient("fake-key");
    const response = await client.review({
      systemPrompt: "You are a reviewer",
      userPrompt: "Review this diff",
      maxTokens: 4096,
      timeoutMs: 60000,
    });

    expect(response.findings).toHaveLength(1);
    expect(response.findings[0].fixStrategy).toBeUndefined();
  });

  it("throws RateLimitError on persistent 429 after exhausting retries", { timeout: 10000 }, async () => {
    type APIErrorCtor = new (status: number, error: unknown, message: string, headers: unknown) => InstanceType<typeof APIError>;
    const Ctor = APIError as unknown as APIErrorCtor;
    const rateLimitErr = new Ctor(429, undefined, "rate limited", {});

    mockCreate = vi.fn().mockRejectedValue(rateLimitErr);

    const client = new ClaudeClient("fake-key");
    await expect(
      client.review({
        systemPrompt: "You are a reviewer",
        userPrompt: "Review this diff",
        maxTokens: 4096,
        timeoutMs: 60000,
      }),
    ).rejects.toThrow(RateLimitError);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("sends fix request with the provided user prompt", async () => {
    const patch = [
      "--- a/src/App.java",
      "+++ b/src/App.java",
      "@@ -1 +1,2 @@",
      "+if (user == null) return null;",
      " return user.getName();",
    ].join("\n");
    mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: `\`\`\`diff\n${patch}\n\`\`\`` }],
    });

    const client = new ClaudeClient("fake-key");
    const response = await client.fix({
      systemPrompt: "You are a fixer",
      userPrompt: "Use this exact fix prompt",
      fileContent: "return user.getName();",
      finding: {
        line: 5,
        severity: "error",
        confidence: "high",
        ruleId: "null-safety",
        autoFixable: true,
        message: "Null dereference",
        codeContext: "user.getName()",
        suggestedApproach: "Add null check",
      },
      maxTokens: 4096,
      timeoutMs: 60000,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "Use this exact fix prompt" }],
      }),
      expect.anything(),
    );
    expect(response.patch).toBe(patch);
  });

  it("warns when review response is truncated but still parses findings", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      stop_reason: "max_tokens",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            findings: [
              {
                line: 5,
                severity: "error",
                confidence: "high",
                ruleId: "null-safety",
                autoFixable: true,
                message: "Null dereference",
                codeContext: "user.getName()",
                suggestedApproach: "Add null check",
              },
            ],
            summary: "1 error found.",
          }),
        },
      ],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const client = new ClaudeClient("fake-key");
      const response = await client.review({
        systemPrompt: "You are a reviewer",
        userPrompt: "Review this diff",
        maxTokens: 4096,
        timeoutMs: 60000,
      });

      expect(response.findings).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/truncated/),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("parses verify verdicts from fenced JSON", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: [
            "```json",
            JSON.stringify({
              verdicts: [
                { index: 0, verdict: "confirm", reason: "Real bug" },
                { index: 1, verdict: "demote", reason: "Low confidence" },
                { index: 2, verdict: "reject", reason: "False positive" },
              ],
            }),
            "```",
          ].join("\n"),
        },
      ],
    });

    const client = new ClaudeClient("fake-key");
    const response = await client.verifyFindings({
      systemPrompt: "You are a verifier",
      userPrompt: "Verify these findings",
      maxTokens: 2048,
      timeoutMs: 60000,
    });

    expect(response.verdicts).toEqual([
      { index: 0, verdict: "confirm", reason: "Real bug" },
      { index: 1, verdict: "demote", reason: "Low confidence" },
      { index: 2, verdict: "reject", reason: "False positive" },
    ]);
  });

  it("drops invalid verify verdicts and defaults missing reason", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            verdicts: [
              { index: 0, verdict: "confirm" },
              { index: 1, verdict: "maybe", reason: "not a real verdict" },
              { index: -2, verdict: "reject", reason: "negative index" },
              { index: 2, verdict: "demote", reason: "keep me" },
            ],
          }),
        },
      ],
    });

    const client = new ClaudeClient("fake-key");
    const response = await client.verifyFindings({
      systemPrompt: "You are a verifier",
      userPrompt: "Verify these findings",
      maxTokens: 2048,
      timeoutMs: 60000,
    });

    expect(response.verdicts).toEqual([
      { index: 0, verdict: "confirm", reason: "" },
      { index: 2, verdict: "demote", reason: "keep me" },
    ]);
  });

  it("throws when verify response is truncated", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      stop_reason: "max_tokens",
      content: [
        {
          type: "text",
          text: JSON.stringify({ verdicts: [] }),
        },
      ],
    });

    const client = new ClaudeClient("fake-key");
    await expect(
      client.verifyFindings({
        systemPrompt: "You are a verifier",
        userPrompt: "Verify these findings",
        maxTokens: 2048,
        timeoutMs: 60000,
      }),
    ).rejects.toThrow(/truncated/);
  });

  it("throws when verify response is not valid JSON", async () => {
    mockCreate = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Sorry, I cannot comply." }],
    });

    const client = new ClaudeClient("fake-key");
    await expect(
      client.verifyFindings({
        systemPrompt: "You are a verifier",
        userPrompt: "Verify these findings",
        maxTokens: 2048,
        timeoutMs: 60000,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("throws RateLimitError on persistent 429 during verify", { timeout: 10000 }, async () => {
    type APIErrorCtor = new (status: number, error: unknown, message: string, headers: unknown) => InstanceType<typeof APIError>;
    const Ctor = APIError as unknown as APIErrorCtor;
    const rateLimitErr = new Ctor(429, undefined, "rate limited", {});

    mockCreate = vi.fn().mockRejectedValue(rateLimitErr);

    const client = new ClaudeClient("fake-key");
    await expect(
      client.verifyFindings({
        systemPrompt: "You are a verifier",
        userPrompt: "Verify these findings",
        maxTokens: 2048,
        timeoutMs: 60000,
      }),
    ).rejects.toThrow(RateLimitError);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("throws when the verify response has no verdicts array", async () => {
    // Fail open like the non-JSON path: returning [] here would demote every
    // finding instead of leaving them untouched.
    mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ results: [] }) }],
    });

    const client = new ClaudeClient("fake-key");
    await expect(
      client.verifyFindings({
        systemPrompt: "You are a verifier",
        userPrompt: "Verify these findings",
        maxTokens: 2048,
        timeoutMs: 60000,
      }),
    ).rejects.toThrow(/no verdicts array/);
  });

  describe("verifyFindings tool use", () => {
    const tools = [
      { name: "read_file", description: "read", input_schema: { type: "object" } },
    ];
    const verdictText = JSON.stringify({
      verdicts: [{ index: 0, verdict: "confirm", reason: "proved by the callee" }],
    });

    it("runs the tool, feeds the result back, and rules on the evidence", async () => {
      mockCreate = vi
        .fn()
        .mockResolvedValueOnce({
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/A.java" } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        })
        .mockResolvedValueOnce({
          stop_reason: "end_turn",
          content: [{ type: "text", text: verdictText }],
          usage: { input_tokens: 20, output_tokens: 8 },
        });

      const executeTool = vi.fn().mockResolvedValue("1: void helper() {}");
      const client = new ClaudeClient("fake-key");
      const res = await client.verifyFindings({
        systemPrompt: "You are a verifier",
        userPrompt: "Verify these findings",
        maxTokens: 2048,
        timeoutMs: 60000,
        tools,
        executeTool,
        maxToolRounds: 3,
      });

      expect(executeTool).toHaveBeenCalledWith("read_file", { path: "src/A.java" });
      expect(res.verdicts).toEqual([
        { index: 0, verdict: "confirm", reason: "proved by the callee" },
      ]);
      expect(res.toolRounds).toBe(1);

      // The tool result must be handed back as a tool_result turn.
      const secondCall = mockCreate.mock.calls[1][0];
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[2].content[0]).toMatchObject({
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "1: void helper() {}",
      });
    });

    it("does not advertise tools when no executor is supplied", async () => {
      mockCreate = vi.fn().mockResolvedValue({
        stop_reason: "end_turn",
        content: [{ type: "text", text: verdictText }],
      });

      const client = new ClaudeClient("fake-key");
      const res = await client.verifyFindings({
        systemPrompt: "You are a verifier",
        userPrompt: "Verify these findings",
        maxTokens: 2048,
        timeoutMs: 60000,
      });

      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("tools");
      expect(res.toolRounds).toBe(0);
    });

    it("gives the model the error text when a tool throws, instead of aborting", async () => {
      mockCreate = vi
        .fn()
        .mockResolvedValueOnce({
          stop_reason: "tool_use",
          content: [
            { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "../etc/passwd" } },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: "end_turn",
          content: [{ type: "text", text: verdictText }],
        });

      const executeTool = vi.fn().mockRejectedValue(new Error("outside the repository"));
      const client = new ClaudeClient("fake-key");
      const res = await client.verifyFindings({
        systemPrompt: "You are a verifier",
        userPrompt: "Verify these findings",
        maxTokens: 2048,
        timeoutMs: 60000,
        tools,
        executeTool,
        maxToolRounds: 3,
      });

      expect(res.verdicts).toHaveLength(1);
      expect(mockCreate.mock.calls[1][0].messages[2].content[0].content).toContain(
        "outside the repository",
      );
    });

    it("throws once the tool-round budget is spent so the caller fails open", async () => {
      mockCreate = vi.fn().mockResolvedValue({
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/A.java" } },
        ],
      });

      const client = new ClaudeClient("fake-key");
      await expect(
        client.verifyFindings({
          systemPrompt: "You are a verifier",
          userPrompt: "Verify these findings",
          maxTokens: 2048,
          timeoutMs: 60000,
          tools,
          executeTool: vi.fn().mockResolvedValue("content"),
          maxToolRounds: 2,
        }),
      ).rejects.toThrow(/tool-round budget/);
      // 2 rounds spent, plus the call that exceeded the budget.
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });
  });
});
