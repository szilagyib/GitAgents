import {
  computeFingerprint,
  type CommentMap,
  type CommentMapEntry,
  type FileReview,
  type Finding,
} from "@gitagents/core";
import {
  type Thread,
} from "@gitagents/forge";

export type ReconciliationActionType = "new" | "unchanged" | "fixed";

export interface ReconciliationAction {
  type: ReconciliationActionType;
  fingerprint: string;
  /** Present for new/unchanged actions (the finding's file). */
  path?: string;
  finding?: Finding;
  previousEntry?: CommentMapEntry;
}

/**
 * Hidden HTML marker embedded in every bot inline comment for stateless dedup.
 * Carries the finding's file path so the reconciler can protect a file's
 * threads from auto-resolution when that file's review fails on a later run.
 */
export function findingMarker(fingerprint: string, path: string): string {
  return `<!-- gitagents:finding:${fingerprint} path=${JSON.stringify(path)} -->`;
}

const FINDING_MARKER_RE =
  /<!--\s*gitagents:finding:([A-Za-z0-9]+)(?:\s+path="([^"]*)")?\s*-->/;

/**
 * Rebuild the previous-run comment map by scanning the MR's own threads for
 * finding markers. This is the source of truth for dedup — it survives artifact
 * expiry and pipeline retries. The artifact `commentMap` is merged underneath as
 * a fallback; a marker found on a live thread always wins.
 */
export function buildPreviousMapFromThreads(
  threads: Thread[],
  fallbackMap: CommentMap = {}
): CommentMap {
  const map: CommentMap = { ...fallbackMap };
  for (const thread of threads) {
    for (const note of thread.notes) {
      const match = note.body.match(FINDING_MARKER_RE);
      if (!match) continue;
      map[match[1]] = {
        threadId: thread.id,
        noteId: note.id,
        ...(match[2] ? { path: match[2] } : {}),
      };
      break; // first marked note in the thread anchors the fingerprint
    }
  }
  return map;
}

/**
 * Reconcile the whole MR's current findings against the previous comment map.
 * Operates over all files at once so that "fixed" (a previous finding that has
 * disappeared) is detected against the entire current finding set — a per-file
 * pass would wrongly mark other files' findings as fixed.
 */
export function classifyFindings(
  fileReviews: FileReview[],
  previousMap: CommentMap,
  mrId: number
): ReconciliationAction[] {
  const actions: ReconciliationAction[] = [];
  const currentFingerprints = new Set<string>();

  for (const fileReview of fileReviews) {
    for (const finding of fileReview.findings) {
      const fp = computeFingerprint(
        mrId,
        finding.ruleId,
        fileReview.path,
        finding.codeContext
      );
      currentFingerprints.add(fp);

      const prev = previousMap[fp];
      if (!prev) {
        actions.push({ type: "new", fingerprint: fp, path: fileReview.path, finding });
      } else {
        actions.push({
          type: "unchanged",
          fingerprint: fp,
          path: fileReview.path,
          finding,
          previousEntry: prev,
        });
      }
    }
  }

  for (const [fp, entry] of Object.entries(previousMap)) {
    if (!currentFingerprints.has(fp)) {
      actions.push({ type: "fixed", fingerprint: fp, previousEntry: entry });
    }
  }

  return actions;
}

/**
 * Build the comment map to persist for the next run. New findings only appear if
 * they were actually posted (present in `newComments`); overflow findings that
 * were capped out are intentionally omitted.
 */
export function buildUpdatedCommentMap(
  actions: ReconciliationAction[],
  newComments: Map<string, { threadId: string; noteId: string }>
): CommentMap {
  const map: CommentMap = {};

  for (const action of actions) {
    switch (action.type) {
      case "new": {
        const comment = newComments.get(action.fingerprint);
        if (comment) {
          map[action.fingerprint] = {
            threadId: comment.threadId,
            noteId: comment.noteId,
            ...(action.path ? { path: action.path } : {}),
          };
        }
        break;
      }
      case "unchanged":
        if (action.previousEntry) {
          map[action.fingerprint] = {
            ...action.previousEntry,
            // Older entries may predate path tracking; backfill from the finding.
            ...(action.previousEntry.path ?? action.path
              ? { path: action.previousEntry.path ?? action.path }
              : {}),
          };
        }
        break;
      // "fixed" — omitted from new map (comment resolved)
    }
  }

  return map;
}
