// The forge port (GitLab + GitHub adapters) lives in @gitagents/forge.

// --- Claude ---
export { ClaudeClient, RateLimitError } from "./claude/client.js";
export type {
  ClaudeSystemPrompt,
  ClaudeSystemPromptBlock,
  ClaudeReviewRequest,
  ClaudeReviewResponse,
  ClaudeFixRequest,
  ClaudeFixResponse,
  ClaudeVerifyRequest,
  ClaudeVerifyResponse,
  ClaudeVerifyVerdict,
  ClaudeTool,
  ClaudeToolExecutor,
  VerifyVerdictKind,
} from "./claude/types.js";

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
  buildClaudeTelemetryAction,
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
