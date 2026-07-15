import { describe, expect, it, vi } from "vitest";
import { fixFinding } from "../src/fixer";
import type { Finding } from "@gitagents/core";

function finding(fixStrategy: NonNullable<Finding["fixStrategy"]>): Finding {
  return {
    line: 1,
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

describe("fixFinding", () => {
  it("uses deterministic fixes without calling Claude", async () => {
    const claude = { fix: vi.fn() };

    const result = await fixFinding(
      claude as any,
      "src/app.test.ts",
      "it.only('works', () => {});\n",
      finding("remove-focused-test"),
      60000
    );

    expect(result.applied).toBe(true);
    expect(result.fixedContent).toBe("it('works', () => {});\n");
    expect(claude.fix).not.toHaveBeenCalled();
  });

  it("falls back to Claude when deterministic fix is unsafe", async () => {
    const claude = {
      fix: vi.fn().mockResolvedValue({
        patch: [
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-console.log(nextValue());",
          "+logger.debug(nextValue());",
        ].join("\n"),
      }),
    };

    const result = await fixFinding(
      claude as any,
      "src/app.ts",
      "console.log(nextValue());",
      finding("remove-console-log"),
      60000
    );

    expect(claude.fix).toHaveBeenCalledOnce();
    expect(result.applied).toBe(true);
  });
});
