import {
  type CommentMap,
} from "@gitagents/core";
import {
  type Forge,
  type RepoRef,
} from "@gitagents/forge";
import type { FindingRef } from "./summary.js";

export interface ResolveFixedThreadsResult {
  resolvedCount: number;
  failed: Array<{ ref: FindingRef; error: string }>;
}

export async function resolveFixedThreads(
  forge: Forge,
  repo: RepoRef,
  prNumber: number,
  applied: Array<{ ref: FindingRef; fingerprint: string }>,
  commentMap: CommentMap
): Promise<ResolveFixedThreadsResult> {
  const result: ResolveFixedThreadsResult = { resolvedCount: 0, failed: [] };

  for (const { ref, fingerprint } of applied) {
    const entry = commentMap[fingerprint];
    if (!entry) continue;
    // Tolerate pre-cutover artifacts that still carry discussionId/numeric noteId.
    const threadId = entry.threadId ?? (entry as any).discussionId;
    const noteId = String(entry.noteId);
    if (!threadId) continue;

    try {
      await forge.addReply(
        repo,
        prNumber,
        threadId,
        noteId,
        `Auto-fix applied for \`${ref.ruleId}\` at \`${ref.path}:${ref.line}\`. Marking thread resolved.`
      );
      await forge.resolveThread(repo, prNumber, threadId, true);
      result.resolvedCount++;
    } catch (err) {
      result.failed.push({
        ref,
        error: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return result;
}
