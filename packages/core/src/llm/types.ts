import type { Finding } from "../types.js";
import type { ClaudeActionContext } from "../telemetry.js";
import type { LlmSystemBlock, LlmToolSpec } from "./provider.js";

/** A system prompt: plain text, or cacheable blocks. */
export type LlmSystemPrompt = string | LlmSystemBlock[];

export interface LlmReviewRequest {
  systemPrompt: LlmSystemPrompt;
  userPrompt: string;
  maxTokens: number;
  timeoutMs: number;
  telemetry?: ClaudeActionContext;
}

export interface LlmReviewResponse {
  findings: Finding[];
  summary: string;
}

export interface LlmFixRequest {
  systemPrompt: LlmSystemPrompt;
  userPrompt: string;
  fileContent: string;
  finding: Finding;
  maxTokens: number;
  timeoutMs: number;
  telemetry?: ClaudeActionContext;
}

export interface LlmFixResponse {
  patch: string;
}

export type VerifyVerdictKind = "confirm" | "demote" | "reject";

export interface LlmVerifyVerdict {
  index: number;
  verdict: VerifyVerdictKind;
  reason: string;
}

/** Runs a tool call and returns its result as text for the model. */
export type LlmToolExecutor = (
  name: string,
  input: Record<string, unknown>,
) => Promise<string>;

export interface LlmVerifyRequest {
  systemPrompt: LlmSystemPrompt;
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
  tools?: LlmToolSpec[];
  executeTool?: LlmToolExecutor;
  /** Hard cap on tool round-trips; the budget bounds cost per file. */
  maxToolRounds?: number;
}

export interface LlmVerifyResponse {
  verdicts: LlmVerifyVerdict[];
  /** How many tool round-trips the model actually used. */
  toolRounds: number;
}
