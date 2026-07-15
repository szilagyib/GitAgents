import { suggestionMarker } from "./markers.js";

// Hidden marker on the single fix summary note per MR, used by
// upsertSummaryComment to find and edit the note in place across runs.
export const FIX_SUMMARY_MARKER = "<!-- gitagents:summary:fix -->";

export interface FindingRef {
  path: string;
  line: number;
  ruleId: string;
  message: string;
}

export interface SkippedRef extends FindingRef {
  reason: string;
}

/** A finding whose suggestion dedup marker must persist in the summary body. */
export interface MarkedRef extends FindingRef {
  fingerprint: string;
}

export interface FallbackRef extends MarkedRef {
  replacementLines: string[];
}

export interface SuggestSummaryInput {
  posted: FindingRef[];
  alreadySuggested: MarkedRef[];
  fallbacks: FallbackRef[];
  skipped: SkippedRef[];
  manual: FindingRef[];
}

export interface FixSummaryInput {
  applied: FindingRef[];
  skipped: SkippedRef[];
  manual: FindingRef[];
  pushError?: string;
}

function formatLocation(f: FindingRef): string {
  return f.line > 0 ? `${f.path}:${f.line}` : f.path;
}

function formatFinding(f: FindingRef): string {
  return `- \`${formatLocation(f)}\` - **${f.ruleId}**: ${f.message}`;
}

function formatSkipped(s: SkippedRef): string {
  return `- \`${formatLocation(s)}\` - **${s.ruleId}**: ${s.message} _(skipped: ${s.reason})_`;
}

export function buildFixSummary(input: FixSummaryInput): string {
  const sections: string[] = [];

  if (input.applied.length > 0) {
    const heading = input.pushError
      ? `**Prepared but not pushed (${input.applied.length}):**`
      : `**Fixed (${input.applied.length}):**`;
    sections.push(`${heading}\n${input.applied.map(formatFinding).join("\n")}`);
  }

  const remaining = input.skipped.length + input.manual.length + (input.pushError ? 1 : 0);
  if (remaining > 0) {
    const lines = [
      ...(input.pushError
        ? [
            formatSkipped({
              path: "git push",
              line: 0,
              ruleId: "push-failed",
              message: "Auto-fix commit could not be pushed",
              reason: input.pushError,
            }),
          ]
        : []),
      ...input.skipped.map(formatSkipped),
      ...input.manual.map(formatFinding),
    ];
    sections.push(`**For you (${remaining}):**\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

function formatFallback(f: FallbackRef): string {
  const header = `- \`${formatLocation(f)}\` - **${f.ruleId}**: ${f.message}`;
  if (f.replacementLines.length === 0) {
    return `${header}\n\n  _(proposed change: delete these lines)_`;
  }
  return `${header}\n\n\`\`\`\n${f.replacementLines.join("\n")}\n\`\`\``;
}

/**
 * Summary body for suggest mode. Nothing is committed here — the developer
 * applies suggestions with one click, so this note only reports what was
 * posted, what was already suggested on a prior run, proposed changes that
 * could not be anchored to the diff, and findings that could not be fixed.
 */
export function buildSuggestSummary(input: SuggestSummaryInput): string {
  const sections: string[] = [];

  if (input.posted.length > 0) {
    sections.push(
      `**Suggested fixes (${input.posted.length}):** apply directly from the review comments.\n` +
        input.posted.map(formatFinding).join("\n")
    );
  }

  if (input.alreadySuggested.length > 0) {
    sections.push(
      `**Already suggested (${input.alreadySuggested.length}):** left in place from an earlier run.\n` +
        input.alreadySuggested.map(formatFinding).join("\n")
    );
  }

  if (input.fallbacks.length > 0) {
    sections.push(
      `**Proposed fixes outside the diff (${input.fallbacks.length}):** could not be anchored as a suggestion; apply manually.\n\n` +
        input.fallbacks.map(formatFallback).join("\n\n")
    );
  }

  if (input.skipped.length > 0) {
    sections.push(
      `**Not auto-fixable (${input.skipped.length}):**\n` +
        input.skipped.map(formatSkipped).join("\n")
    );
  }

  if (input.manual.length > 0) {
    sections.push(
      `**Needs manual attention (${input.manual.length}):**\n` +
        input.manual.map(formatFinding).join("\n")
    );
  }

  if (sections.length === 0) return "";

  // Persist dedup markers for suggestions that have no inline thread of their
  // own (fallbacks) or whose thread may be gone (already-suggested): the next
  // run scans this summary so it never recomputes the same Claude fix.
  const markers = [...input.alreadySuggested, ...input.fallbacks].map((ref) =>
    suggestionMarker(ref.fingerprint)
  );

  return [...sections, ...(markers.length > 0 ? [markers.join("\n")] : [])].join("\n\n");
}

export function shouldAddManualLabel(input: {
  skipped: SkippedRef[];
  manual: FindingRef[];
  pushError?: string;
}): boolean {
  return input.skipped.length + input.manual.length > 0 || Boolean(input.pushError);
}
