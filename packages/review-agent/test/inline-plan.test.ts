import { describe, it, expect } from "vitest";
import { inlinePriority, planInlineComments } from "../src/inline-plan";
import type { Finding } from "@gitagents/core";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  line: 1,
  severity: "error",
  confidence: "high",
  ruleId: "some-rule",
  autoFixable: false,
  message: "msg",
  codeContext: "code",
  suggestedApproach: "fix",
  ...overrides,
});

describe("inlinePriority", () => {
  it("ranks blocking above error+high above error above warning", () => {
    const blocking = finding({ gateEligible: true, verified: true });
    const errorHigh = finding({ confidence: "high" });
    const errorMed = finding({ confidence: "medium" });
    const warning = finding({ severity: "warning", confidence: "medium" });

    expect(inlinePriority(blocking)).toBe(0);
    expect(inlinePriority(errorHigh)).toBe(1);
    expect(inlinePriority(errorMed)).toBe(2);
    expect(inlinePriority(warning)).toBe(3);
  });
});

describe("planInlineComments", () => {
  it("posts the highest-priority findings and overflows the rest", () => {
    const items = [
      { finding: finding({ ruleId: "warn", severity: "warning", confidence: "medium" }) },
      { finding: finding({ ruleId: "block", gateEligible: true, verified: true }) },
      { finding: finding({ ruleId: "err-high", confidence: "high" }) },
      { finding: finding({ ruleId: "err-med", confidence: "medium" }) },
    ];

    const { toPost, overflow } = planInlineComments(items, 2);

    expect(toPost.map((i) => i.finding.ruleId)).toEqual(["block", "err-high"]);
    expect(overflow.map((i) => i.finding.ruleId)).toEqual(["err-med", "warn"]);
  });

  it("posts everything when the cap exceeds the candidate count", () => {
    const items = [{ finding: finding() }, { finding: finding({ line: 2 }) }];
    const { toPost, overflow } = planInlineComments(items, 15);
    expect(toPost).toHaveLength(2);
    expect(overflow).toHaveLength(0);
  });
});
