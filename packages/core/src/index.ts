// The forge port (GitLab + GitHub adapters) lives in @gitagents/forge.

// --- LLM ---
export { LlmClient, RateLimitError } from "./llm/client.js";
export { resolveLlmConfig, createLlmProvider, createLlmClient } from "./llm/config.js";
export type { LlmConfig } from "./llm/config.js";
export { AnthropicProvider } from "./llm/anthropic.js";
export { OpenAiProvider } from "./llm/openai.js";
export { getModelPricing } from "./llm/pricing.js";
export type { ModelPricing, ModelPricingOverride } from "./llm/pricing.js";
export type {
  LlmProvider,
  LlmProviderId,
  LlmSystemBlock,
  LlmToolSpec,
  LlmToolCall,
  LlmMessage,
  LlmMessageRequest,
  LlmMessageResponse,
  LlmStopReason,
  NormalizedUsage,
} from "./llm/provider.js";
export type {
  LlmSystemPrompt,
  LlmReviewRequest,
  LlmReviewResponse,
  LlmFixRequest,
  LlmFixResponse,
  LlmVerifyRequest,
  LlmVerifyResponse,
  LlmVerifyVerdict,
  LlmToolExecutor,
  VerifyVerdictKind,
} from "./llm/types.js";

// --- Config ---
export {
  parseRuleFile,
  mergeRules,
  loadRules,
  loadPersonality,
  loadReviewContext,
  getRulesForFile,
} from "./config/loader.js";
export type {
  Rule,
  RuleApplicability,
  RuleMap,
  LanguageRules,
  Personality,
  Suppression,
  ProjectNote,
  ReviewContext,
  ParsedRuleFile,
} from "./config/types.js";

// --- Core Types ---
export {
  isFinding,
  normalizeFinding,
  isReviewArtifact,
  isFixResultArtifact,
  computeFingerprint,
} from "./types.js";

// --- Retry ---
export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
export type {
  Severity,
  Confidence,
  GateResult,
  ArtifactSource,
  FixStrategy,
  Finding,
  FileReview,
  CommentMapEntry,
  CommentMap,
  ReviewArtifact,
  ReviewStatus,
  BlockingRef,
  RejectedFinding,
  FixResultArtifact,
  FixResultFindingRef,
  FixResultSkippedRef,
} from "./types.js";

// --- Telemetry ---
export {
  DashboardTelemetryRecorder,
  TELEMETRY_PRICING_SOURCE,
  buildLlmTelemetryAction,
  calculateClaudeCost,
  createId,
  getClaudePricing,
  parseTokenUsage,
} from "./telemetry.js";
export type {
  AgentActionTelemetry,
  ClaudeActionContext,
  ClaudePricing,
  DashboardTelemetryRecorderOptions,
  TelemetryArtifact,
  TelemetrySink,
  TokenUsage,
} from "./telemetry.js";
