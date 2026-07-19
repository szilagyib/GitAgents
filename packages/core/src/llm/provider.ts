/**
 * Provider-neutral LLM interface. Adapters (Anthropic, OpenAI) translate these
 * normalized shapes to and from their SDKs; all review/fix/verify orchestration
 * is written against this interface and never sees a provider SDK directly.
 */

export type LlmProviderId = "anthropic" | "openai";

export interface LlmSystemBlock {
  text: string;
  /** Anthropic prompt-cache hint; ignored by providers that cache automatically. */
  cacheable?: boolean;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A conversation turn. The `assistant` turn keeps its text and tool calls so an
 * adapter can replay it in its native format on the next tool round.
 */
export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: LlmToolCall[] }
  | { role: "tool_result"; toolCallId: string; content: string };

export interface LlmMessageRequest {
  model: string;
  maxTokens: number;
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  timeoutMs?: number;
}

export type LlmStopReason = "end" | "max_tokens" | "tool_use" | "other";

export interface NormalizedUsage {
  /** Uncached input tokens only. */
  inputTokens: number;
  outputTokens: number;
  /** Cache-creation tokens (Anthropic); 0 where writing the cache is free (OpenAI). */
  cacheWriteTokens: number;
  /** Cache-read tokens (Anthropic cache read / OpenAI cached prompt tokens). */
  cacheReadTokens: number;
}

export interface LlmMessageResponse {
  /** Concatenated text output. */
  text: string;
  toolCalls: LlmToolCall[];
  stopReason: LlmStopReason;
  usage: NormalizedUsage;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  createMessage(req: LlmMessageRequest): Promise<LlmMessageResponse>;
  /** 429 / 5xx / network error → the shared retry loop should retry. */
  isTransientError(err: unknown): boolean;
  /** 429 → surface as RateLimitError so callers can fail open. */
  isRateLimitError(err: unknown): boolean;
}
