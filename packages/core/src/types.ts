// --- Severity & Confidence ---
export type Severity = "error" | "warning";
export type Confidence = "high" | "medium" | "low";
export type GateResult = "pass" | "fail";
export type ArtifactSource = "review-agent" | "fix-agent";
export type FixStrategy =
  | "local-null-guard"
  | "optional-chain"
  | "nullish-coalescing"
  | "require-non-null"
  | "remove-debugger"
  | "remove-focused-test"
  | "remove-console-log"
  | "remove-system-out"
  | "generic-local-edit"
  | "manual-only";

// --- Finding ---
export interface Finding {
  line: number;
  severity: Severity;
  confidence: Confidence;
  ruleId: string;
  autoFixable: boolean;
  message: string;
  codeContext: string;
  suggestedApproach: string;
  fixStrategy?: FixStrategy;
  fixabilityReason?: string;
  fixSkipped?: boolean;
  fixSkipReason?: string;
  /** Whether the reviewer confirmed the finding against the code (vs. a raw model claim). */
  verified?: boolean;
  /** Whether this finding is allowed to contribute to a merge-blocking decision. */
  gateEligible?: boolean;
  /**
   * Set to "static" only by the deterministic static checks. Model findings can
   * never carry it (normalizeFinding does not copy it), so gate policy can trust
   * it as provenance when exempting mechanical findings from the verifier.
   */
  origin?: "static";
}

const SEVERITIES: Set<string> = new Set(["error", "warning"]);
const CONFIDENCES: Set<string> = new Set(["high", "medium", "low"]);
const FIX_STRATEGIES: Set<string> = new Set([
  "local-null-guard",
  "optional-chain",
  "nullish-coalescing",
  "require-non-null",
  "remove-debugger",
  "remove-focused-test",
  "remove-console-log",
  "remove-system-out",
  "generic-local-edit",
  "manual-only",
]);

export function isFinding(obj: unknown): obj is Finding {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.line === "number" &&
    typeof o.severity === "string" && SEVERITIES.has(o.severity) &&
    typeof o.confidence === "string" && CONFIDENCES.has(o.confidence) &&
    typeof o.ruleId === "string" &&
    typeof o.autoFixable === "boolean" &&
    typeof o.message === "string" &&
    typeof o.codeContext === "string" &&
    typeof o.suggestedApproach === "string" &&
    (o.fixStrategy === undefined ||
      (typeof o.fixStrategy === "string" && FIX_STRATEGIES.has(o.fixStrategy))) &&
    (o.fixabilityReason === undefined || typeof o.fixabilityReason === "string")
  );
}

export function normalizeFinding(obj: unknown): Finding | null {
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const hasRequiredShape =
    typeof o.line === "number" &&
    typeof o.severity === "string" && SEVERITIES.has(o.severity) &&
    typeof o.confidence === "string" && CONFIDENCES.has(o.confidence) &&
    typeof o.ruleId === "string" &&
    typeof o.autoFixable === "boolean" &&
    typeof o.message === "string" &&
    typeof o.codeContext === "string" &&
    typeof o.suggestedApproach === "string";

  if (!hasRequiredShape) return null;

  const line = o.line as number;
  const severity = o.severity as Severity;
  const confidence = o.confidence as Confidence;
  const ruleId = o.ruleId as string;
  const autoFixable = o.autoFixable as boolean;
  const message = o.message as string;
  const codeContext = o.codeContext as string;
  const suggestedApproach = o.suggestedApproach as string;
  const strategy =
    typeof o.fixStrategy === "string" && FIX_STRATEGIES.has(o.fixStrategy)
      ? o.fixStrategy as FixStrategy
      : undefined;

  return {
    line,
    severity,
    confidence,
    ruleId,
    autoFixable,
    message,
    codeContext,
    suggestedApproach,
    ...(strategy ? { fixStrategy: strategy } : {}),
    ...(typeof o.fixabilityReason === "string"
      ? { fixabilityReason: o.fixabilityReason }
      : {}),
    ...(typeof o.verified === "boolean" ? { verified: o.verified } : {}),
    ...(typeof o.gateEligible === "boolean" ? { gateEligible: o.gateEligible } : {}),
  };
}

// --- File Review ---
export interface FileReview {
  path: string;
  language: string;
  findings: Finding[];
}

// --- Comment Map ---
export interface CommentMapEntry {
  threadId: string;
  noteId: string;
  /**
   * File the finding was reported on. Lets the reconciler protect a file's
   * threads from auto-resolution when that file's review failed this run.
   * Optional because artifact entries written before this field existed lack it.
   */
  path?: string;
}
export type CommentMap = Record<string, CommentMapEntry>;

// --- Review Artifact ---
// Output of review-agent. Findings + reconciliation state for the next run.
// fixAttemptCount lives in FixResultArtifact instead (it's fix-agent's concern).

/** A finding that is contributing to the merge-blocking decision. */
export interface BlockingRef {
  path: string;
  line: number;
  ruleId: string;
  message: string;
}

/** A finding that was dropped before gating, with the reason it was excluded. */
export interface RejectedFinding {
  path: string;
  line: number;
  ruleId: string;
  message: string;
  reason: string;
}

/** Whether the review ran to completion or was cut short by a rate limit. */
export type ReviewStatus = "completed" | "rate-limited";

export interface ReviewArtifact {
  prNumber: number;
  repoSlug: string;
  timestamp: string;
  source: ArtifactSource;
  files: FileReview[];
  totals: { errors: number; warnings: number };
  gateResult: GateResult;
  commentMap: CommentMap;
  reviewStatus: ReviewStatus;
  blocking: BlockingRef[];
  rejected: RejectedFinding[];
}

export function isReviewArtifact(obj: unknown): obj is ReviewArtifact {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  const hasBaseShape =
    typeof o.prNumber === "number" &&
    typeof o.repoSlug === "string" &&
    typeof o.timestamp === "string" &&
    (o.source === "review-agent" || o.source === "fix-agent") &&
    Array.isArray(o.files) &&
    typeof o.totals === "object" && o.totals !== null &&
    (o.gateResult === "pass" || o.gateResult === "fail") &&
    typeof o.commentMap === "object" && o.commentMap !== null;
  if (!hasBaseShape) return false;

  // The blocking/reviewStatus/rejected fields are newer than some persisted
  // artifacts. Accept legacy artifacts that omit them, but reject malformed
  // values when they are present.
  if (o.reviewStatus !== undefined &&
      o.reviewStatus !== "completed" && o.reviewStatus !== "rate-limited") return false;
  if (o.blocking !== undefined && !Array.isArray(o.blocking)) return false;
  if (o.rejected !== undefined && !Array.isArray(o.rejected)) return false;
  return true;
}

// --- Fix Result Artifact ---
// Output of fix-agent. Just the delta — what it applied, what it skipped,
// what's left for the developer. Doesn't duplicate the findings array;
// readers cross-reference with the review artifact when they need the
// full finding context.
export interface FixResultFindingRef {
  path: string;
  line: number;
  ruleId: string;
  message: string;
}

export interface FixResultSkippedRef extends FixResultFindingRef {
  reason: string;
}

export interface FixResultArtifact {
  prNumber: number;
  repoSlug: string;
  timestamp: string;
  source: "fix-agent";
  fixAttemptCount: number;
  fixesApplied: boolean;
  appliedFixCount: number;
  applied: FixResultFindingRef[];
  skipped: FixResultSkippedRef[];
  manual: FixResultFindingRef[];
}

export function isFixResultArtifact(obj: unknown): obj is FixResultArtifact {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.prNumber === "number" &&
    typeof o.repoSlug === "string" &&
    typeof o.timestamp === "string" &&
    o.source === "fix-agent" &&
    typeof o.fixAttemptCount === "number" &&
    typeof o.fixesApplied === "boolean" &&
    typeof o.appliedFixCount === "number" &&
    Array.isArray(o.applied) &&
    Array.isArray(o.skipped) &&
    Array.isArray(o.manual)
  );
}

// --- Fingerprint ---
// Anchors a finding by (mrId, ruleId, filePath, line). Intentionally
// NOT keyed on line content: fix-agent's edits change the text at a
// given line, but the logical bug location stays the same. Keying on
// content caused every fix to re-post the same finding as "new" in the
// next review.
/**
 * Stable identity of a finding within one MR/PR. Anchored on the flagged code
 * text (whitespace-collapsed) instead of the line number, so the fingerprint
 * survives line drift when unrelated edits shift the file — line-based
 * fingerprints caused every shifted finding to be resolved and re-posted.
 * Two findings of the same rule on identical code text in the same file
 * intentionally collapse into one fingerprint (one comment covers both).
 */
export function computeFingerprint(mrId: number, ruleId: string, filePath: string, codeContext: string): string {
  const anchor = codeContext.replace(/\s+/g, " ").trim();
  const input = `${mrId}:${ruleId}:${filePath}:${anchor}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}
