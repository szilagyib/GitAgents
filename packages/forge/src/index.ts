// Forge port: one interface, one adapter per platform. Every mutating call
// (comments, threads, labels) is made here by deterministic code — the model
// never gets a write tool.
export { GitLabForge } from "./gitlab.js";
export { GitHubForge } from "./github.js";
export { createForge, detectForgeKind, buildRepoRef } from "./factory.js";
export type { ForgeKind, CreateForgeOptions, CreatedForge } from "./factory.js";
export { parseDiffHunks } from "./diff.js";
export type { DiffLineInfo, DiffLineKind } from "./diff.js";
export { isTransientForgeError } from "./types.js";
export type {
  Forge,
  RepoRef,
  PullRequestInfo,
  FileDiff,
  Thread,
  ThreadNote,
  InlineTarget,
  SuggestionTarget,
  InlineCommentResult,
} from "./types.js";
