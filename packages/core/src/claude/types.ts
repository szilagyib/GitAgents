import type { Finding } from "../types.js";
import type { ClaudeActionContext } from "../telemetry.js";

export interface ClaudeSystemPromptBlock {
  text: string;
  cacheable?: boolean;
}

export type ClaudeSystemPrompt = string | ClaudeSystemPromptBlock[];

export interface ClaudeReviewRequest {
  systemPrompt: ClaudeSystemPrompt;
  userPrompt: string;
  maxTokens: number;
  timeoutMs: number;
  telemetry?: ClaudeActionContext;
}

export interface ClaudeReviewResponse {
  findings: Finding[];
  summary: string;
}

export interface ClaudeFixRequest {
  systemPrompt: ClaudeSystemPrompt;
  userPrompt: string;
  fileContent: string;
  finding: Finding;
  maxTokens: number;
  timeoutMs: number;
  telemetry?: ClaudeActionContext;
}

export interface ClaudeFixResponse {
  patch: string;
}

export type VerifyVerdictKind = "confirm" | "demote" | "reject";

export interface ClaudeVerifyVerdict {
  index: number;
  verdict: VerifyVerdictKind;
  reason: string;
}

/** A read-only tool the verifier may call to gather evidence. */
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Runs a tool call and returns its result as text for the model. */
export type ClaudeToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

export interface ClaudeVerifyRequest {
  systemPrompt: ClaudeSystemPrompt;
  userPrompt: string;
  maxTokens: number;
  timeoutMs: number;
  telemetry?: ClaudeActionContext;
  /**
   * Read-only evidence tools. Without them the verifier can only judge what is
   * in the prompt, so any claim needing another file gets blanket-demoted.
   * Never expose a tool with side effects: gating and comment posting are
   * code-enforced precisely so the model cannot decide them.
   */
  tools?: ClaudeTool[];
  executeTool?: ClaudeToolExecutor;
  /** Hard cap on tool round-trips; the budget bounds cost per file. */
  maxToolRounds?: number;
}

export interface ClaudeVerifyResponse {
  verdicts: ClaudeVerifyVerdict[];
  /** How many tool round-trips the model actually used. */
  toolRounds: number;
}
