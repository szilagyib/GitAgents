import { splitContent } from "./patch.js";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/** A contiguous replacement span in ORIGINAL-file coordinates (1-indexed, inclusive). */
export interface ChangedRange {
  startLine: number;
  endLine: number;
  replacementLines: string[];
}

const SURROUNDING_LINES = 5;

/**
 * Computes the longest common subsequence indices of two arrays of strings.
 * Returns an array of [originalIndex, fixedIndex] pairs for matched lines.
 */
function lcsIndices(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

/**
 * Validates that a proposed fix only modifies lines within the allowed window.
 *
 * The rule: lines strictly before the flagged line must not be changed or
 * removed. Lines from the flagged line onward may change, but only within
 * windowSize lines after it.
 *
 * Uses LCS-based diffing to find which original lines were removed/changed
 * and where insertions landed in original coordinates.
 */
export function validateFix(
  originalContent: string,
  fixedContent: string,
  flaggedLine: number,
  windowSize: number = SURROUNDING_LINES
): ValidationResult {
  const originalLines = originalContent.split("\n");
  const fixedLines = fixedContent.split("\n");

  // Allowed window in 0-indexed coordinates.
  // Lines strictly before the flagged line (0-indexed: flaggedLine - 1) must
  // remain unchanged. Lines from flaggedLine - 1 through flaggedLine - 1 +
  // windowSize may be modified.
  const windowStart = flaggedLine - 1; // 0-indexed: first line that may change
  const windowEnd = flaggedLine - 1 + windowSize; // 0-indexed: last line that may change

  const matched = lcsIndices(originalLines, fixedLines);
  const matchedOriginalIndices = new Set(matched.map(([oi]) => oi));

  // Check removed/changed original lines
  for (let i = 0; i < originalLines.length; i++) {
    if (!matchedOriginalIndices.has(i)) {
      if (i < windowStart || i > windowEnd) {
        return {
          valid: false,
          reason: `over-edit: line ${i + 1} was changed but is outside the allowed window (lines ${windowStart + 1}-${Math.min(windowEnd + 1, originalLines.length)})`,
        };
      }
    }
  }

  // Check insertions: find the original position of each unmatched fixed line
  // using the ceiling of neighbouring matched pairs.
  const matchedFixedIndices = new Set(matched.map(([, fi]) => fi));

  for (let fi = 0; fi < fixedLines.length; fi++) {
    if (matchedFixedIndices.has(fi)) continue;

    // Find the next matched pair at or after fi to get the ceiling original pos
    let insertOriginalPos = originalLines.length; // default: after all original lines
    for (const [oi, mfi] of matched) {
      if (mfi >= fi) {
        insertOriginalPos = oi;
        break;
      }
    }

    if (insertOriginalPos < windowStart || insertOriginalPos > windowEnd) {
      return {
        valid: false,
        reason: `over-edit: insertion near line ${insertOriginalPos + 1} is outside the allowed window (lines ${windowStart + 1}-${Math.min(windowEnd + 1, originalLines.length)})`,
      };
    }
  }

  return { valid: true };
}

/**
 * Derives the minimal contiguous replacement span between two versions of a
 * file, in 1-indexed inclusive ORIGINAL-file coordinates, along with the
 * replacement lines from the fixed content.
 *
 * Built on the same LCS the over-edit check uses, so the region it reports is
 * consistent with what {@link validateFix} considered "changed". The over-edit
 * window already guarantees every applied fix is one contiguous <=6-line span,
 * so the bounding box below collapses to that single region in practice; any
 * unchanged interior lines are included verbatim to keep the span contiguous.
 *
 * Splitting is EOL-aware: CRLF is normalized before diffing and replacement
 * lines are returned LF-clean (native suggestion bodies must not carry \r).
 * A trailing final newline is not treated as a phantom line, so the returned
 * line numbers match the diff's new-file numbering.
 *
 * Returns null when the two versions carry the same lines (identical, or
 * differing only by line endings / a trailing newline).
 */
export function computeChangedRange(
  originalContent: string,
  fixedContent: string
): ChangedRange | null {
  if (originalContent === fixedContent) return null;

  const original = splitContent(originalContent).lines;
  const fixed = splitContent(fixedContent).lines;

  const matched = lcsIndices(original, fixed);

  // Common prefix: leading matched pairs that sit in-place from the top.
  let prefix = 0;
  while (
    prefix < matched.length &&
    matched[prefix][0] === prefix &&
    matched[prefix][1] === prefix
  ) {
    prefix++;
  }

  // Common suffix: trailing matched pairs anchored to both sequence ends,
  // without crossing into the prefix already consumed.
  let suffix = 0;
  while (
    suffix < matched.length - prefix &&
    matched[matched.length - 1 - suffix][0] === original.length - 1 - suffix &&
    matched[matched.length - 1 - suffix][1] === fixed.length - 1 - suffix
  ) {
    suffix++;
  }

  const origStart = prefix; // 0-indexed, inclusive
  const origEnd = original.length - suffix - 1; // 0-indexed, inclusive
  const fixedStart = prefix;
  const fixedEnd = fixed.length - suffix - 1;

  const removed = origEnd >= origStart;
  const inserted = fixedEnd >= fixedStart;

  if (!removed && !inserted) return null; // same lines (e.g. EOL-only diff)

  if (!removed) {
    // Pure insertion: suggestion blocks replace lines, so anchor to an
    // existing original line and re-emit it alongside the inserted lines.
    if (original.length === 0) return null; // nothing to anchor to
    if (prefix >= 1) {
      // Insert after original line `prefix`: replace it with itself + inserted.
      return {
        startLine: prefix,
        endLine: prefix,
        replacementLines: fixed.slice(prefix - 1, fixedEnd + 1),
      };
    }
    // Insertion above the first line: replace line 1 with inserted + line 1.
    return {
      startLine: 1,
      endLine: 1,
      replacementLines: fixed.slice(0, fixedEnd + 2),
    };
  }

  return {
    startLine: origStart + 1,
    endLine: origEnd + 1,
    replacementLines: inserted ? fixed.slice(fixedStart, fixedEnd + 1) : [],
  };
}
