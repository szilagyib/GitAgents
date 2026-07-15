import { describe, expect, it } from "vitest";
import { tryDeterministicFix } from "../src/deterministic-fixes";
import type { Finding } from "@gitagents/core";

function finding(fixStrategy: NonNullable<Finding["fixStrategy"]>, line = 1): Finding {
  return {
    line,
    severity: "error",
    confidence: "high",
    ruleId: fixStrategy,
    autoFixable: true,
    fixStrategy,
    fixabilityReason: "Safe local edit.",
    message: "Fix me",
    codeContext: "code",
    suggestedApproach: "Apply local edit",
  };
}

describe("tryDeterministicFix", () => {
  it("removes .only without calling the model", () => {
    const result = tryDeterministicFix(
      "src/app.test.ts",
      "describe.only('x', () => {});\n",
      finding("remove-focused-test")
    );

    expect(result?.applied).toBe(true);
    expect(result?.fixedContent).toBe("describe('x', () => {});\n");
  });

  it("removes a debugger statement", () => {
    const result = tryDeterministicFix(
      "src/app.ts",
      "const a = 1;\ndebugger;\nconst b = 2;\n",
      finding("remove-debugger", 2)
    );

    expect(result?.applied).toBe(true);
    expect(result?.fixedContent).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("removes simple diagnostic console logging", () => {
    const result = tryDeterministicFix(
      "src/app.ts",
      "console.log(value);\n",
      finding("remove-console-log")
    );

    expect(result?.applied).toBe(true);
    expect(result?.fixedContent).toBe("");
  });

  it("does not remove side-effectful console arguments", () => {
    const result = tryDeterministicFix(
      "src/app.ts",
      "console.log(nextValue());\n",
      finding("remove-console-log")
    );

    expect(result).toBeNull();
  });

  it("removes simple System.out logging", () => {
    const result = tryDeterministicFix(
      "src/App.java",
      "System.out.println(value);\n",
      finding("remove-system-out")
    );

    expect(result?.applied).toBe(true);
    expect(result?.fixedContent).toBe("");
  });

  it("preserves CRLF line endings when removing a debugger statement", () => {
    const crlf = "const a = 1;\r\ndebugger;\r\nconst b = 2;\r\n";
    const result = tryDeterministicFix(
      "src/app.ts",
      crlf,
      finding("remove-debugger", 2)
    );

    expect(result?.applied).toBe(true);
    // Every surviving line keeps its CRLF ending; the validator's window check
    // must accept the edit (it would reject if interior EOLs were corrupted).
    expect(result?.fixedContent).toBe("const a = 1;\r\nconst b = 2;\r\n");
  });

  it("preserves CRLF line endings when replacing a focused test", () => {
    const crlf = "describe('a', () => {});\r\ndescribe.only('b', () => {});\r\ndescribe('c', () => {});\r\n";
    const result = tryDeterministicFix(
      "src/app.test.ts",
      crlf,
      finding("remove-focused-test", 2)
    );

    expect(result?.applied).toBe(true);
    expect(result?.fixedContent).toBe(
      "describe('a', () => {});\r\ndescribe('b', () => {});\r\ndescribe('c', () => {});\r\n"
    );
  });
});
