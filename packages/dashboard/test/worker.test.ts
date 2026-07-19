import { describe, expect, it } from "vitest";
import {
  hasValidBearerToken,
  readRequestText,
  readTelemetryAction,
} from "../src/worker";

describe("dashboard worker", () => {
  it("accepts only the configured bearer token", async () => {
    await expect(
      hasValidBearerToken(
        new Request("https://dashboard.example/api/telemetry", {
          headers: { authorization: "Bearer correct-token" },
        }),
        "correct-token",
      ),
    ).resolves.toBe(true);

    await expect(
      hasValidBearerToken(
        new Request("https://dashboard.example/api/telemetry", {
          headers: { authorization: "Bearer wrong-token" },
        }),
        "correct-token",
      ),
    ).resolves.toBe(false);
  });

  it("validates and enriches telemetry actions", () => {
    expect(
      readTelemetryAction({
        action: {
          id: "act-1",
          runId: "run-1",
          agent: "review-agent",
          action: "review-file",
        },
        metadata: { repository: "example/repo" },
      }),
    ).toMatchObject({
      id: "act-1",
      runId: "run-1",
      dashboardMetadata: { repository: "example/repo" },
    });
    expect(readTelemetryAction({ action: { id: "missing-fields" } })).toBeNull();
  });

  it("stops buffering request bodies at the configured byte limit", async () => {
    await expect(
      readRequestText(
        new Request("https://dashboard.example/api/telemetry/actions", {
          method: "POST",
          body: "12345",
        }),
        4,
      ),
    ).resolves.toBeNull();

    await expect(
      readRequestText(
        new Request("https://dashboard.example/api/telemetry/actions", {
          method: "POST",
          body: "1234",
        }),
        4,
      ),
    ).resolves.toBe("1234");
  });
});
