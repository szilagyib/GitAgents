import { describe, it, expect } from "vitest";
import { parseRuleFile, mergeRules } from "../../src/config/loader";

const COMMON_MD = `# Common Review Rules

## null-safety
severity: error
Check for null dereferences.

## naming-conventions
severity: warning
Use clear names.
`;

const JAVA_MD = `---
extensions: [.java]
---
# Java Review Rules

## naming-conventions
severity: warning
PascalCase classes. camelCase methods.

## optional-usage
severity: error
signals: [optional]
requiredSignals: [java]
Use Optional<T> over null.
`;

const CPP_MD = `---
extensions: [.c, .cpp, .h, .hpp]
---
# C/C++ Review Rules

## buffer-bounds
severity: error
signals: [buffer]
Flag unsafe buffer access.
`;

describe("parseRuleFile", () => {
  it("parses common rules (no frontmatter)", () => {
    const result = parseRuleFile(COMMON_MD);
    expect(result.extensions).toEqual([]);
    expect(result.rules.size).toBe(2);
    expect(result.rules.get("null-safety")?.severity).toBe("error");
    expect(result.rules.get("naming-conventions")?.severity).toBe("warning");
  });

  it("parses language rules with frontmatter extensions", () => {
    const result = parseRuleFile(JAVA_MD);
    expect(result.extensions).toEqual([".java"]);
    expect(result.rules.size).toBe(2);
    expect(result.rules.get("optional-usage")?.severity).toBe("error");
    expect(result.rules.get("optional-usage")?.applicability?.signals).toEqual(["optional"]);
    expect(result.rules.get("optional-usage")?.applicability?.requiredSignals).toEqual(["java"]);
    expect(result.rules.get("optional-usage")?.description).not.toContain("signals:");
    expect(result.rules.get("optional-usage")?.description).not.toContain("requiredSignals:");
  });

  it("parses C/C++ language extensions", () => {
    const result = parseRuleFile(CPP_MD);
    expect(result.extensions).toEqual([".c", ".cpp", ".h", ".hpp"]);
    expect(result.rules.get("buffer-bounds")?.applicability?.signals).toEqual(["buffer"]);
  });
});

const GATE_MD = `# Rules

## gated-rule
severity: error
gate: true
Blocks the merge.

## ungated-rule
severity: warning
gate: false
Does not block the merge.

## default-gate
severity: error
No gate line, defaults to false.
`;

describe("parseRuleFile — gate flag", () => {
  it("parses gate: true", () => {
    const result = parseRuleFile(GATE_MD);
    expect(result.rules.get("gated-rule")?.gate).toBe(true);
  });

  it("parses gate: false", () => {
    const result = parseRuleFile(GATE_MD);
    expect(result.rules.get("ungated-rule")?.gate).toBe(false);
  });

  it("defaults gate to false when absent", () => {
    const result = parseRuleFile(GATE_MD);
    expect(result.rules.get("default-gate")?.gate).toBe(false);
  });

  it("parses gate value case-insensitively", () => {
    const result = parseRuleFile(`## r\nseverity: error\ngate: TRUE\nDesc.\n`);
    expect(result.rules.get("r")?.gate).toBe(true);
  });

  it("excludes the gate line from the description", () => {
    const result = parseRuleFile(GATE_MD);
    const description = result.rules.get("gated-rule")?.description ?? "";
    expect(description).not.toContain("gate:");
    expect(description).toContain("Blocks the merge.");
  });
});

describe("parseRuleFile — severity validation", () => {
  it("throws naming the rule when severity is missing", () => {
    const md = `# Rules\n\n## null-safety\nCheck for null dereferences.\n`;
    expect(() => parseRuleFile(md)).toThrow(/null-safety/);
  });

  it("throws naming the rule when severity value is invalid", () => {
    const md = `# Rules\n\n## null-safety\nseverity: warn\nCheck.\n`;
    expect(() => parseRuleFile(md)).toThrow(/null-safety/);
  });
});

describe("mergeRules", () => {
  it("overrides common rules with language rules of the same ID", () => {
    const common = parseRuleFile(COMMON_MD);
    const java = parseRuleFile(JAVA_MD);
    const merged = mergeRules(common.rules, java.rules);
    expect(merged.get("naming-conventions")?.description).toContain("PascalCase");
    expect(merged.get("null-safety")?.severity).toBe("error");
    expect(merged.get("optional-usage")?.severity).toBe("error");
    expect(merged.size).toBe(3);
  });
});
