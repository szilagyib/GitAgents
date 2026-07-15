import { describe, expect, it } from "vitest";
import type { Finding } from "@gitagents/core";
import { normalizeFixability } from "../src/fixability";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    line: 5,
    severity: "error",
    confidence: "high",
    ruleId: "null-safety",
    autoFixable: false,
    fixStrategy: "manual-only",
    fixabilityReason: "There are multiple possible fixes.",
    message: "This can throw a NullPointerException when user is null.",
    codeContext: "user.getName()",
    suggestedApproach: "Add a narrow local guard before dereferencing user.",
    ...overrides,
  };
}

describe("normalizeFixability", () => {
  it("upgrades obvious null dereferences to auto-fixable local guards", () => {
    const normalized = normalizeFixability("src/UserService.java", finding());

    expect(normalized.autoFixable).toBe(true);
    expect(normalized.fixStrategy).toBe("local-null-guard");
  });

  it("upgrades obvious typecast guards to generic local edits", () => {
    const normalized = normalizeFixability(
      "src/UserService.java",
      finding({
        ruleId: "typecasting",
        message: "Unchecked cast can throw ClassCastException.",
        codeContext: "(User) value",
        suggestedApproach: "Add an instanceof guard before casting.",
      }),
    );

    expect(normalized.autoFixable).toBe(true);
    expect(normalized.fixStrategy).toBe("generic-local-edit");
  });

  it("keeps broad fixes manual", () => {
    const normalized = normalizeFixability(
      "src/UserService.java",
      finding({
        ruleId: "schema-migration",
        message: "This needs a database migration and business rule decision.",
        suggestedApproach: "Coordinate a schema migration.",
      }),
    );

    expect(normalized.autoFixable).toBe(false);
    expect(normalized.fixStrategy).toBe("manual-only");
    expect(normalized.fixabilityReason).toContain("broader context");
  });

  it("does not trust auto-fixable on never-auto-fix rules", () => {
    const normalized = normalizeFixability(
      "src/UserService.java",
      finding({
        autoFixable: true,
        fixStrategy: "generic-local-edit",
        ruleId: "authorization",
        message: "Authorization bypass needs a permission model decision.",
        suggestedApproach: "Decide the required role before changing this endpoint.",
      }),
    );

    expect(normalized.autoFixable).toBe(false);
    expect(normalized.fixStrategy).toBe("manual-only");
    expect(normalized.fixabilityReason).toContain("intentionally blocked");
  });

  it("does not trust auto-fixable on broad-context findings", () => {
    const normalized = normalizeFixability(
      "src/UserService.java",
      finding({
        autoFixable: true,
        fixStrategy: "generic-local-edit",
        ruleId: "api-contract",
        message: "Public API contract change needs caller coordination.",
        suggestedApproach: "Update all consumers and document the migration plan.",
      }),
    );

    expect(normalized.autoFixable).toBe(false);
    expect(normalized.fixStrategy).toBe("manual-only");
    expect(normalized.fixabilityReason).toContain("broader context");
  });

  it("does not auto-fix low-confidence findings", () => {
    const normalized = normalizeFixability(
      "src/app.ts",
      finding({
        autoFixable: true,
        confidence: "low",
        fixStrategy: "generic-local-edit",
        ruleId: "typo-corrections",
        message: "Possible typo in user-visible text.",
        codeContext: '"Sucess"',
        suggestedApproach: 'Change "Sucess" to "Success".',
      }),
    );

    expect(normalized.autoFixable).toBe(false);
    expect(normalized.fixStrategy).toBe("manual-only");
    expect(normalized.fixabilityReason).toContain("Low-confidence");
  });

  it("trusts auto-fixable findings and supplies a usable strategy", () => {
    const normalized = normalizeFixability(
      "src/app.ts",
      finding({
        autoFixable: true,
        fixStrategy: "manual-only",
        ruleId: "typo-corrections",
        message: "Typo in user-visible text.",
        codeContext: '"Sucess"',
        suggestedApproach: 'Change "Sucess" to "Success".',
      }),
    );

    expect(normalized.autoFixable).toBe(true);
    expect(normalized.fixStrategy).toBe("generic-local-edit");
  });
});
