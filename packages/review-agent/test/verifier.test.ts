import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyFileFindings } from "../src/verifier";
import type { ClaudeClient, Finding } from "@gitagents/core";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  line: 1,
  severity: "error",
  confidence: "high",
  ruleId: "some-rule",
  autoFixable: false,
  message: "msg",
  codeContext: "code",
  suggestedApproach: "fix",
  gateEligible: true,
  ...overrides,
});

function clientWith(verifyFindings: ReturnType<typeof vi.fn>): ClaudeClient {
  return { verifyFindings } as unknown as ClaudeClient;
}

describe("verifyFileFindings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns immediately without an API call when there are no findings", async () => {
    const verifyFindings = vi.fn();
    const result = await verifyFileFindings({
      claudeClient: clientWith(verifyFindings),
      filePath: "a.ts",
      fileContext: "1 +code",
      findings: [],
      timeoutMs: 1000,
    });

    expect(verifyFindings).not.toHaveBeenCalled();
    expect(result.verificationRan).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("applies confirm / demote / reject verdicts and preserves gateEligible", async () => {
    const verifyFindings = vi.fn().mockResolvedValue({
      verdicts: [
        { index: 0, verdict: "confirm", reason: "provable" },
        { index: 1, verdict: "demote", reason: "needs context" },
        { index: 2, verdict: "reject", reason: "fires on a comment" },
      ],
    });

    const result = await verifyFileFindings({
      claudeClient: clientWith(verifyFindings),
      filePath: "a.ts",
      fileContext: "1 +code",
      findings: [
        finding({ line: 1, ruleId: "confirmed" }),
        finding({ line: 2, ruleId: "demoted" }),
        finding({ line: 3, ruleId: "rejected" }),
      ],
      timeoutMs: 1000,
    });

    expect(result.verificationRan).toBe(true);
    expect(result.findings).toHaveLength(2);

    const confirmed = result.findings.find((f) => f.ruleId === "confirmed")!;
    expect(confirmed.verified).toBe(true);
    expect(confirmed.confidence).toBe("high");
    expect(confirmed.gateEligible).toBe(true);

    const demoted = result.findings.find((f) => f.ruleId === "demoted")!;
    expect(demoted.verified).toBe(false);
    expect(demoted.confidence).toBe("medium");

    expect(result.rejected).toEqual([
      {
        path: "a.ts",
        line: 3,
        ruleId: "rejected",
        message: "msg",
        reason: "fires on a comment",
      },
    ]);
  });

  it("treats a finding with no verdict as a demotion (conservative)", async () => {
    const verifyFindings = vi.fn().mockResolvedValue({
      verdicts: [{ index: 0, verdict: "confirm", reason: "ok" }],
    });

    const result = await verifyFileFindings({
      claudeClient: clientWith(verifyFindings),
      filePath: "a.ts",
      fileContext: "1 +code",
      findings: [finding({ ruleId: "confirmed" }), finding({ line: 2, ruleId: "no-verdict" })],
      timeoutMs: 1000,
    });

    const unverdicted = result.findings.find((f) => f.ruleId === "no-verdict")!;
    expect(unverdicted.confidence).toBe("medium");
    expect(unverdicted.verified).toBe(false);
    expect(result.rejected).toEqual([]);
  });

  it("fails open on any throw: returns findings unchanged, nothing rejected", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const verifyFindings = vi.fn().mockRejectedValue(new Error("truncated"));
    const original = [finding({ ruleId: "a" }), finding({ line: 2, ruleId: "b" })];

    const result = await verifyFileFindings({
      claudeClient: clientWith(verifyFindings),
      filePath: "a.ts",
      fileContext: "1 +code",
      findings: original,
      timeoutMs: 1000,
    });

    expect(result.verificationRan).toBe(false);
    expect(result.findings).toBe(original);
    expect(result.findings.every((f) => f.verified === undefined)).toBe(true);
    expect(result.rejected).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
  });
});
