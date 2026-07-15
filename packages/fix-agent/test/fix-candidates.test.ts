import { describe, expect, it } from "vitest";
import type { Finding } from "@gitagents/core";
import { isFixCandidate, isManualActionNeeded } from "../src/cli";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    line: 12,
    severity: "error",
    confidence: "high",
    ruleId: "null-safety",
    autoFixable: true,
    fixStrategy: "local-null-guard",
    fixabilityReason: "Safe local edit.",
    message: "This can throw a NullPointerException when user is null.",
    codeContext: "user.getName()",
    suggestedApproach: "Add a narrow null guard before dereferencing user.",
    ...overrides,
  };
}

describe("isFixCandidate", () => {
  it("attempts high-confidence auto-fixable findings", () => {
    expect(isFixCandidate(finding())).toBe(true);
  });

  it("does not override autoFixable=false even for simple null crashes", () => {
    expect(isFixCandidate(finding({ autoFixable: false }))).toBe(false);
  });

  it("trusts autoFixable even for medium-confidence warnings", () => {
    expect(
      isFixCandidate(finding({ severity: "warning", confidence: "medium" }))
    ).toBe(true);
  });
});

describe("isManualActionNeeded", () => {
  it("labels non-fixable high-confidence errors as developer work", () => {
    expect(isManualActionNeeded(finding({ autoFixable: false }))).toBe(true);
  });

  it("does not label low-risk warnings as manual-fix-needed", () => {
    expect(
      isManualActionNeeded(
        finding({ severity: "warning", confidence: "medium", autoFixable: false }),
      ),
    ).toBe(false);
  });
});
