import { describe, it, expect } from "vitest";
import {
  STATIC_GATE_ELIGIBLE,
  applyGatePolicy,
  isBlocking,
  computeBlocking,
} from "../src/severity-policy";
import type { Finding, Rule, RuleMap, FileReview } from "@gitagents/core";

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
  verified: true,
  ...overrides,
});

const rule = (ruleId: string, gate: boolean): Rule => ({
  ruleId,
  severity: "error",
  gate,
  description: "d",
});

describe("applyGatePolicy", () => {
  it("marks a finding gate-eligible when its rule declares gate: true", () => {
    const rules: RuleMap = new Map([["secret-handling", rule("secret-handling", true)]]);
    const [f] = applyGatePolicy([finding({ ruleId: "secret-handling", gateEligible: undefined })], rules);
    expect(f.gateEligible).toBe(true);
  });

  it("marks a finding NOT gate-eligible when its rule declares gate: false", () => {
    const rules: RuleMap = new Map([["authorization", rule("authorization", false)]]);
    const [f] = applyGatePolicy([finding({ ruleId: "authorization", gateEligible: undefined })], rules);
    expect(f.gateEligible).toBe(false);
  });

  it("falls back to the static eligibility set when the rule is unknown", () => {
    const rules: RuleMap = new Map();
    const [eligible] = applyGatePolicy([finding({ ruleId: "merge-conflict-marker", gateEligible: undefined })], rules);
    const [ineligible] = applyGatePolicy([finding({ ruleId: "missing-file-reference", gateEligible: undefined })], rules);
    expect(eligible.gateEligible).toBe(true);
    expect(ineligible.gateEligible).toBe(false);
  });

  it("only allows the three known static rules to gate", () => {
    expect([...STATIC_GATE_ELIGIBLE].sort()).toEqual([
      "debugger-statement",
      "focused-test",
      "merge-conflict-marker",
    ]);
  });
});

describe("isBlocking", () => {
  it("blocks only when error + high + gateEligible + verified all hold", () => {
    expect(isBlocking(finding())).toBe(true);
  });

  it("does not block a warning", () => {
    expect(isBlocking(finding({ severity: "warning" }))).toBe(false);
  });

  it("does not block medium/low confidence", () => {
    expect(isBlocking(finding({ confidence: "medium" }))).toBe(false);
    expect(isBlocking(finding({ confidence: "low" }))).toBe(false);
  });

  it("does not block a gate-ineligible finding", () => {
    expect(isBlocking(finding({ gateEligible: false }))).toBe(false);
    expect(isBlocking(finding({ gateEligible: undefined }))).toBe(false);
  });

  it("does not block an unverified finding", () => {
    expect(isBlocking(finding({ verified: false }))).toBe(false);
    expect(isBlocking(finding({ verified: undefined }))).toBe(false);
  });
});

describe("computeBlocking", () => {
  it("collects blocking findings across files into refs", () => {
    const fileReviews: FileReview[] = [
      {
        path: "a.ts",
        language: "typescript",
        findings: [
          finding({ line: 3, ruleId: "secret-handling" }),
          finding({ line: 9, verified: false }), // not verified -> excluded
        ],
      },
      {
        path: "b.ts",
        language: "typescript",
        findings: [finding({ line: 1, ruleId: "typecasting" })],
      },
    ];

    const blocking = computeBlocking(fileReviews);
    expect(blocking).toEqual([
      { path: "a.ts", line: 3, ruleId: "secret-handling", message: "msg" },
      { path: "b.ts", line: 1, ruleId: "typecasting", message: "msg" },
    ]);
  });
});
