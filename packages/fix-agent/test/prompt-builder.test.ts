import { describe, expect, it } from "vitest";
import { buildFixSystemPrompt, buildFixUserPrompt } from "../src/prompt-builder";
import type { LlmSystemPrompt, Finding } from "@gitagents/core";

function promptText(prompt: LlmSystemPrompt): string {
  return typeof prompt === "string" ? prompt : prompt.map((block) => block.text).join("\n\n");
}

const baseFinding: Finding = {
  line: 5,
  severity: "error",
  confidence: "high",
  ruleId: "null-safety",
  autoFixable: true,
  message: "Possible null dereference",
  codeContext: "user.getName()",
  suggestedApproach: "Add a local guard",
  fixStrategy: "local-null-guard",
  fixabilityReason: "A local guard prevents the dereference without changing valid inputs.",
};

describe("fix prompt builder", () => {
  it("adds Java null-guard strategy guidance", () => {
    const prompt = promptText(buildFixSystemPrompt("src/UserService.java", baseFinding));

    expect(prompt).toContain("Strategy: local-null-guard for Java");
    expect(prompt).toContain("Do not introduce Optional");
    expect(prompt).toContain("NO_SAFE_FIX");
  });

  it("adds TypeScript optional-chain strategy guidance", () => {
    const prompt = promptText(buildFixSystemPrompt("src/app.ts", {
      ...baseFinding,
      fixStrategy: "optional-chain",
    }));

    expect(prompt).toContain("Strategy: optional-chain");
    expect(prompt).toContain("resulting undefined value is already safe");
  });

  it("includes strategy metadata in the user prompt", () => {
    const prompt = buildFixUserPrompt(
      "src/app.ts",
      "const name = user.name;",
      baseFinding
    );

    expect(prompt).toContain("**Fix strategy:** local-null-guard");
    expect(prompt).toContain("**Fixability reason:** A local guard");
  });

  it("uses the same inferred strategy in system and user prompts for old findings", () => {
    const legacyFinding: Finding = {
      ...baseFinding,
      fixStrategy: undefined,
      fixabilityReason: undefined,
      suggestedApproach: "Add null check",
    };

    const systemPrompt = promptText(buildFixSystemPrompt("src/app.ts", legacyFinding));
    const userPrompt = buildFixUserPrompt(
      "src/app.ts",
      "const name = user.name;",
      legacyFinding
    );

    expect(systemPrompt).toContain("Strategy: local-null-guard for TypeScript/JavaScript");
    expect(userPrompt).toContain("**Fix strategy:** local-null-guard");
  });

  it("marks reusable fix instructions cacheable", () => {
    const prompt = buildFixSystemPrompt("src/UserService.java", baseFinding);
    expect(typeof prompt).not.toBe("string");
    expect(typeof prompt !== "string" && prompt.every((block) => block.cacheable)).toBe(true);
  });

  it("wraps file content in <file-under-review> tags in the user prompt", () => {
    const prompt = buildFixUserPrompt(
      "src/app.ts",
      "const name = user.name;",
      baseFinding
    );
    expect(prompt).toMatch(/<file-under-review[^>]*>/);
    expect(prompt).toContain("</file-under-review>");
    expect(prompt).toContain("const name = user.name;");
  });

  it("instructs the model in the system prompt that file content is untrusted", () => {
    const prompt = promptText(buildFixSystemPrompt("src/UserService.java", baseFinding));
    expect(prompt).toContain("<file-under-review>");
    expect(prompt).toMatch(/untrusted|do not follow|treat .* as data/i);
  });
});
