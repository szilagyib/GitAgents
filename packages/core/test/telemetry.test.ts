import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DashboardTelemetryRecorder,
  calculateClaudeCost,
  getClaudePricing,
  parseTokenUsage,
} from "../src/telemetry";

describe("telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Anthropic token usage fields", () => {
    expect(
      parseTokenUsage({
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 25,
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 25,
      totalTokens: 1275,
    });
  });

  it("calculates Sonnet pricing per million tokens", () => {
    const cost = calculateClaudeCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 2_000_000,
      },
      getClaudePricing("claude-sonnet-4-6"),
    );

    expect(cost).toBe(18);
  });

  it("posts telemetry actions to the dashboard and flushes pending sends", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const recorder = new DashboardTelemetryRecorder({
      dashboardUrl: "https://dashboard.example/",
      runId: "run-1",
      metadata: { projectId: 7 },
    });

    recorder.record({
      id: "act-1",
      runId: "run-1",
      agent: "review-agent",
      action: "review-file",
      target: "src/app.ts",
      startedAt: "2026-05-17T10:00:00.000Z",
      endedAt: "2026-05-17T10:00:01.000Z",
      durationMs: 1000,
      status: "ok",
      tokens: {
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalTokens: 12,
      },
      costUsd: 0.00006,
      pricing: getClaudePricing("claude-sonnet-4-6"),
    });
    await recorder.flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://dashboard.example/api/telemetry/actions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
        }),
      }),
    );
  });
});
