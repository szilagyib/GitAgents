import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt } from "../src/prompt-builder";
import type { ClaudeSystemPrompt, RuleMap, Personality, ReviewContext } from "@gitagents/core";

function promptText(prompt: ClaudeSystemPrompt): string {
  return typeof prompt === "string" ? prompt : prompt.map((block) => block.text).join("\n\n");
}

describe("buildSystemPrompt", () => {
  const personality: Personality = { raw: "You are sarcastic." };
  const rules: RuleMap = new Map([
    [
      "null-safety",
      { ruleId: "null-safety", severity: "error", description: "Check nulls" },
    ],
  ]);
  const emptyContext: ReviewContext = { suppressions: [], projectNotes: [] };

  it("includes personality", () => {
    const prompt = promptText(buildSystemPrompt(personality, rules, emptyContext, "src/App.java"));
    expect(prompt).toContain("You are sarcastic.");
  });

  it("includes rules with severity", () => {
    const prompt = promptText(buildSystemPrompt(personality, rules, emptyContext, "src/App.java"));
    expect(prompt).toContain("null-safety");
    expect(prompt).toContain("error");
  });

  it("includes structured review methodology phases", () => {
    const prompt = promptText(buildSystemPrompt(personality, rules, emptyContext, "src/App.java"));
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("Phase 2");
    expect(prompt).toContain("Phase 3");
    expect(prompt).toContain("Phase 4");
    expect(prompt).toContain("Phase 5");
    expect(prompt).toContain("senior engineer");
  });

  it("includes false-positive guardrails for method-name rules and CLI idioms", () => {
    const prompt = promptText(buildSystemPrompt(personality, rules, emptyContext, "src/App.java"));
    expect(prompt).toContain("Verify before flagging");
    expect(prompt).toContain("receiver");
    expect(prompt).toContain("JavaFX");
    expect(prompt).toMatch(/System\.(out|err)/);
    expect(prompt).toMatch(/quality.*volume/i);
  });

  it("treats minimal local null guards as auto-fixable", () => {
    const prompt = promptText(buildSystemPrompt(personality, rules, emptyContext, "src/App.java"));
    expect(prompt).toContain("obvious null/undefined guards");
    expect(prompt).toContain("multiple fixes are theoretically possible");
    expect(prompt).toContain("fixStrategy");
    expect(prompt).toContain("fixabilityReason");
    expect(prompt).toContain("local-null-guard");
  });

  it("treats easy same-file fixes as auto-fixable", () => {
    const prompt = promptText(buildSystemPrompt(personality, rules, emptyContext, "src/App.java"));
    expect(prompt).toContain("small local edit");
    expect(prompt).toContain("safe instanceof/type guards");
    expect(prompt).toContain("typo/spelling corrections");
    expect(prompt).toContain("Use generic-local-edit");
  });

  it("includes suppressions when matching path", () => {
    const context: ReviewContext = {
      suppressions: [
        {
          ruleId: "null-safety",
          pathPattern: "src/**",
          reason: "Known pattern",
          addedBy: "platform-team",
          addedAt: "2026-04-02",
        },
      ],
      projectNotes: [],
    };
    const prompt = promptText(buildSystemPrompt(personality, rules, context, "src/App.java"));
    expect(prompt).toContain("Do not flag");
    expect(prompt).toContain("null-safety");
  });

  it("marks the stable review instructions cacheable", () => {
    const prompt = buildSystemPrompt(personality, rules, emptyContext, "src/App.java");
    expect(typeof prompt).not.toBe("string");
    expect(typeof prompt !== "string" && prompt[0].cacheable).toBe(true);
  });

  it("includes detected project profiles in the volatile prompt block", () => {
    const prompt = promptText(
      buildSystemPrompt(personality, rules, emptyContext, "src/App.java", {
        profiles: new Set(["emf-desktop"]),
        signals: new Set(["emf", "java"]),
        evidence: ["test"],
      }),
    );

    expect(prompt).toContain("Detected Project Profile");
    expect(prompt).toContain("emf-desktop");
    expect(prompt).toContain("do not apply Spring web rules");
  });
});

describe("buildUserPrompt", () => {
  it("includes file path and context", () => {
    const prompt = buildUserPrompt("src/App.java", "1  +public class App {}", [1]);
    expect(prompt).toContain("src/App.java");
    expect(prompt).toContain("public class App");
    expect(prompt).toContain("Changed lines that can receive findings: 1");
  });

  it("wraps file content in <file-under-review> tags for injection isolation", () => {
    const prompt = buildUserPrompt("src/App.java", "+public class App {}", [1]);
    expect(prompt).toMatch(/<file-under-review[^>]*>/);
    expect(prompt).toContain("</file-under-review>");
    expect(prompt).toContain("public class App {}");
  });
});

describe("buildSystemPrompt — injection defense", () => {
  it("instructs the model that file content is untrusted and not an instruction", () => {
    const personality: Personality = { raw: "personality" };
    const rules: RuleMap = new Map();
    const context: ReviewContext = { suppressions: [], projectNotes: [] };
    const prompt = promptText(buildSystemPrompt(personality, rules, context, "src/App.java"));

    expect(prompt).toContain("<file-under-review>");
    expect(prompt).toMatch(/untrusted|do not follow|treat .* as data/i);
  });
});
