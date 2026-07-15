import { describe, it, expect } from "vitest";
import { applySuppressions } from "../src/suppressions";
import type { FileReview, Finding, Suppression } from "@gitagents/core";

const finding = (ruleId: string, line: number): Finding => ({
  line,
  severity: "error",
  confidence: "high",
  ruleId,
  autoFixable: false,
  message: "msg",
  codeContext: "code",
  suggestedApproach: "fix",
});

const suppression = (ruleId: string, pathPattern: string): Suppression => ({
  ruleId,
  pathPattern,
  reason: "known",
  addedBy: "platform-team",
  addedAt: "2026-07-07",
});

describe("applySuppressions", () => {
  it("returns input unchanged when there are no suppressions", () => {
    const fileReviews: FileReview[] = [
      { path: "src/a.ts", language: "typescript", findings: [finding("r1", 1)] },
    ];
    const result = applySuppressions(fileReviews, []);
    expect(result.suppressedCount).toBe(0);
    expect(result.fileReviews).toBe(fileReviews);
  });

  it("drops findings matching ruleId + minimatch path pattern and counts them", () => {
    const fileReviews: FileReview[] = [
      {
        path: "src/legacy/App.ts",
        language: "typescript",
        findings: [finding("authorization", 3), finding("null-safety", 7)],
      },
      {
        path: "src/core/Main.ts",
        language: "typescript",
        findings: [finding("authorization", 1)],
      },
    ];

    const result = applySuppressions(fileReviews, [
      suppression("authorization", "src/legacy/**"),
    ]);

    expect(result.suppressedCount).toBe(1);
    expect(result.fileReviews[0].findings.map((f) => f.ruleId)).toEqual(["null-safety"]);
    // A different path is unaffected by the legacy-scoped suppression.
    expect(result.fileReviews[1].findings.map((f) => f.ruleId)).toEqual(["authorization"]);
  });
});
