/**
 * Hidden marker embedded in each suggestion comment — and in the fix summary
 * for fallbacks that never got an inline thread — for stateless dedup.
 */
export function suggestionMarker(fingerprint: string): string {
  return `<!-- gitagents:suggestion:${fingerprint} -->`;
}

export const SUGGESTION_MARKER_RE = /<!--\s*gitagents:suggestion:([A-Za-z0-9]+)\s*-->/g;
