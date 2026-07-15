// Platform-agnostic forge abstraction. GitLab and GitHub each implement Forge.

export type RepoRef =
  | { forge: "gitlab"; projectId: number; slug: string }
  | { forge: "github"; owner: string; repo: string; slug: string };

export interface PullRequestInfo {
  number: number;
  sourceBranch: string;
  targetBranch: string;
  labels: string[];
  headSha: string;
  diffRefs: { baseSha: string; startSha: string; headSha: string };
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  diff: string; // unified diff hunk text
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
}

export interface ThreadNote {
  id: string;
  body: string;
  authorUsername: string;
}

export interface Thread {
  id: string;
  notes: ThreadNote[];
}

export interface InlineTarget {
  path: string;
  newLine: number;
  diff: string; // the file's diff, for hunk lookup / side selection
}

export interface SuggestionTarget {
  path: string;
  startLine: number; // first new-file line the suggestion replaces (inclusive)
  endLine: number; // last new-file line the suggestion replaces (inclusive)
  diff: string; // the file's diff, for hunk lookup / anchorability
}

export interface InlineCommentResult {
  threadId: string;
  noteId: string;
}

export interface Forge {
  getPullRequest(repo: RepoRef, prNumber: number): Promise<PullRequestInfo>;
  getDiffs(repo: RepoRef, prNumber: number): Promise<FileDiff[]>;
  getFileContent(repo: RepoRef, path: string, ref: string): Promise<string>;
  createInlineComment(
    repo: RepoRef,
    prNumber: number,
    target: InlineTarget,
    body: string
  ): Promise<InlineCommentResult | null>;
  createSummaryComment(
    repo: RepoRef,
    prNumber: number,
    body: string
  ): Promise<string>;
  // Finds the bot's existing summary note by the hidden `marker` and edits it in
  // place, or creates it if absent. `marker` is appended to `body` when missing.
  upsertSummaryComment(
    repo: RepoRef,
    prNumber: number,
    marker: string,
    body: string
  ): Promise<string>;
  // Returns the body of the bot summary note identified by the hidden `marker`,
  // or null when no such note exists. Used to scan dedup markers persisted in
  // the summary (e.g. suggestion fallbacks that never got an inline thread).
  getSummaryComment(
    repo: RepoRef,
    prNumber: number,
    marker: string
  ): Promise<string | null>;
  // Posts a positioned comment carrying a native applyable suggestion that
  // replaces lines startLine..endLine (inclusive, new-file numbering). Returns
  // null when the range is not anchorable in the diff (caller falls back).
  createSuggestionComment(
    repo: RepoRef,
    prNumber: number,
    target: SuggestionTarget,
    explanation: string,
    replacementLines: string[]
  ): Promise<InlineCommentResult | null>;
  resolveThread(
    repo: RepoRef,
    prNumber: number,
    threadId: string,
    resolved: boolean
  ): Promise<void>;
  addReply(
    repo: RepoRef,
    prNumber: number,
    threadId: string,
    noteId: string,
    body: string
  ): Promise<void>;
  getThreads(repo: RepoRef, prNumber: number): Promise<Thread[]>;
  addLabel(repo: RepoRef, prNumber: number, label: string): Promise<void>;
  removeLabel(repo: RepoRef, prNumber: number, label: string): Promise<void>;
}

// Shared transient-error classifier for both forges (HTTP 429 / 5xx / network).
export function isTransientForgeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const cause = e.cause as Record<string, unknown> | undefined;
  const response = (cause?.response ?? e.response) as
    | { status?: number }
    | undefined;
  const status =
    response?.status ?? (typeof e.status === "number" ? e.status : undefined);
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status < 600);
  }
  if (err instanceof Error) {
    return /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(
      err.message
    );
  }
  return false;
}
