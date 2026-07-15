import { describe, it, expect, vi } from "vitest";
import { reviewFile } from "../src/reviewer";
import type { ClaudeReviewResponse } from "@gitagents/core";

const mockReview = vi.fn<() => Promise<ClaudeReviewResponse>>();
vi.mock("@gitagents/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gitagents/core")>();
  return {
    ...actual,
    ClaudeClient: vi.fn().mockImplementation(() => ({
      review: mockReview,
    })),
  };
});

describe("reviewFile", () => {
  it("returns findings from Claude response", async () => {
    mockReview.mockResolvedValue({
      findings: [
        {
          line: 5,
          severity: "error",
          confidence: "high",
          ruleId: "null-safety",
          autoFixable: true,
          message: "Null deref",
          codeContext: "user.getName()",
          suggestedApproach: "Add null check",
        },
      ],
      summary: "1 issue",
    });

    const result = await reviewFile({
      filePath: "src/App.java",
      hybridContext: "1  +code",
      systemPrompt: "Review this",
      changedLines: [5],
      fileLines: ["", "", "", "", "const name = user.name;"],
      claudeClient: { review: mockReview } as any,
      timeoutMs: 60000,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe("null-safety");
  });

  it("filters findings that are not anchored to changed lines", async () => {
    mockReview.mockResolvedValue({
      findings: [
        {
          line: 5,
          severity: "error",
          confidence: "high",
          ruleId: "null-safety",
          autoFixable: true,
          message: "Null deref",
          codeContext: "user.getName()",
          suggestedApproach: "Add null check",
        },
        {
          line: 4,
          severity: "warning",
          confidence: "medium",
          ruleId: "naming-conventions",
          autoFixable: false,
          message: "Context line gripe",
          codeContext: "getName",
          suggestedApproach: "Rename it",
        },
      ],
      summary: "2 issues",
    });

    const result = await reviewFile({
      filePath: "src/App.java",
      hybridContext: "1  +code",
      systemPrompt: "Review this",
      changedLines: [5],
      fileLines: ["", "", "", "function getName() {}", "const name = user.name;"],
      claudeClient: { review: mockReview } as any,
      timeoutMs: 60000,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].line).toBe(5);
  });

  it("adds deterministic static findings", async () => {
    mockReview.mockResolvedValue({
      findings: [],
      summary: "No issues",
    });

    const result = await reviewFile({
      filePath: "src/app.test.ts",
      hybridContext: "1  +it.only('works', () => {})",
      systemPrompt: "Review this",
      changedLines: [1],
      fileLines: ["it.only('works', () => {})"],
      claudeClient: { review: mockReview } as any,
      timeoutMs: 60000,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe("focused-test");
  });

  it("keeps precomputed findings from repository checks", async () => {
    mockReview.mockResolvedValue({
      findings: [],
      summary: "No issues",
    });

    const result = await reviewFile({
      filePath: "src/app.ts",
      hybridContext: "1  +import Widget from './Widget';",
      systemPrompt: "Review this",
      changedLines: [1],
      fileLines: ["import Widget from './Widget';"],
      preFindings: [
        {
          line: 1,
          severity: "error",
          confidence: "high",
          ruleId: "missing-file-reference",
          autoFixable: false,
          fixStrategy: "manual-only",
          fixabilityReason: "Missing file must be committed.",
          message: "Missing file",
          codeContext: "import Widget from './Widget';",
          suggestedApproach: "Commit the file.",
        },
      ],
      claudeClient: { review: mockReview } as any,
      timeoutMs: 60000,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe("missing-file-reference");
  });

  it("dedupes precomputed and model findings", async () => {
    const duplicate = {
      line: 1,
      severity: "error" as const,
      confidence: "high" as const,
      ruleId: "missing-file-reference",
      autoFixable: false,
      fixStrategy: "manual-only" as const,
      fixabilityReason: "Missing file must be committed.",
      message: "Missing file",
      codeContext: "import Widget from './Widget';",
      suggestedApproach: "Commit the file.",
    };
    mockReview.mockResolvedValue({
      findings: [duplicate],
      summary: "1 issue",
    });

    const result = await reviewFile({
      filePath: "src/app.ts",
      hybridContext: "1  +import Widget from './Widget';",
      systemPrompt: "Review this",
      changedLines: [1],
      fileLines: ["import Widget from './Widget';"],
      preFindings: [duplicate],
      claudeClient: { review: mockReview } as any,
      timeoutMs: 60000,
    });

    expect(result.findings).toHaveLength(1);
  });

  it("keeps static findings when Claude review fails", async () => {
    mockReview.mockRejectedValue(new Error("API error"));

    const result = await reviewFile({
      filePath: "src/app.ts",
      hybridContext: "1  +debugger;",
      systemPrompt: "Review this",
      changedLines: [1],
      fileLines: ["debugger;"],
      claudeClient: { review: mockReview } as any,
      timeoutMs: 60000,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].ruleId).toBe("debugger-statement");
    expect(result.error).toBeDefined();
  });

  it("returns empty findings on error", async () => {
    mockReview.mockRejectedValue(new Error("API error"));

    const result = await reviewFile({
      filePath: "src/App.java",
      hybridContext: "1  +code",
      systemPrompt: "Review this",
      changedLines: [1],
      fileLines: ["const value = 1;"],
      claudeClient: { review: mockReview } as any,
      timeoutMs: 60000,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.error).toBeDefined();
  });
});
