import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { withRetry } from "@gitagents/core";
import { parseDiffHunks } from "./diff.js";
import {
  isTransientForgeError,
  type Forge,
  type RepoRef,
  type PullRequestInfo,
  type FileDiff,
  type Thread,
  type InlineTarget,
  type SuggestionTarget,
  type InlineCommentResult,
} from "./types.js";

type GhRepo = { owner: string; repo: string };

function ghRepo(repo: RepoRef): GhRepo {
  if (repo.forge !== "github") {
    throw new Error(`GitHubForge received a non-github RepoRef: ${repo.forge}`);
  }
  return { owner: repo.owner, repo: repo.repo };
}

const REVIEW_THREADS_QUERY = `
query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id
          isResolved
          comments(first:50){ nodes{ databaseId body author{ login } } }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `
mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } }
}`;

const UNRESOLVE_MUTATION = `
mutation($threadId:ID!){
  unresolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } }
}`;

interface RawReviewThread {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      databaseId: number;
      body: string;
      author: { login: string } | null;
    }>;
  };
}

export class GitHubForge implements Forge {
  private octokit: Octokit;
  private gql: typeof graphql;
  private headShaCache = new Map<number, string>();

  constructor(apiBaseUrl: string, token: string) {
    this.octokit = new Octokit({ auth: token, baseUrl: apiBaseUrl });
    // GHES serves REST at https://host/api/v3 but GraphQL at https://host/api/graphql,
    // and @octokit/graphql expects the /api root there. github.com's
    // https://api.github.com works unchanged.
    this.gql = graphql.defaults({
      baseUrl: apiBaseUrl.replace(/\/api\/v3\/?$/, "/api"),
      headers: { authorization: `token ${token}` },
    });
  }

  async getPullRequest(repo: RepoRef, prNumber: number): Promise<PullRequestInfo> {
    const { data } = await this.octokit.rest.pulls.get({
      ...ghRepo(repo),
      pull_number: prNumber,
    });
    this.headShaCache.set(prNumber, data.head.sha);
    return {
      number: data.number,
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      labels: (data.labels ?? []).map((l: any) =>
        typeof l === "string" ? l : l.name
      ),
      headSha: data.head.sha,
      diffRefs: {
        baseSha: data.base.sha,
        startSha: data.base.sha,
        headSha: data.head.sha,
      },
    };
  }

  async getDiffs(repo: RepoRef, prNumber: number): Promise<FileDiff[]> {
    const files = (await this.octokit.paginate(
      this.octokit.rest.pulls.listFiles,
      { ...ghRepo(repo), pull_number: prNumber, per_page: 100 }
    )) as Array<{
      filename: string;
      previous_filename?: string;
      patch?: string;
      status: string;
    }>;
    return files.map((f) => ({
      oldPath: f.previous_filename ?? f.filename,
      newPath: f.filename,
      diff: f.patch ?? "",
      newFile: f.status === "added",
      renamedFile: f.status === "renamed",
      deletedFile: f.status === "removed",
    }));
  }

  async getFileContent(repo: RepoRef, path: string, ref: string): Promise<string> {
    const { data } = await this.octokit.rest.repos.getContent({
      ...ghRepo(repo),
      path,
      ref,
    });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      throw new Error(`Path ${path} is not a file`);
    }
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  private async headShaFor(repo: RepoRef, prNumber: number): Promise<string> {
    const cached = this.headShaCache.get(prNumber);
    if (cached) return cached;
    await this.getPullRequest(repo, prNumber);
    return this.headShaCache.get(prNumber)!;
  }

  // Walks every reviewThreads page: dedup markers live on old threads, so a
  // busy PR with >100 threads must not silently truncate the scan.
  private async fetchThreads(
    repo: RepoRef,
    prNumber: number
  ): Promise<RawReviewThread[]> {
    const { owner, repo: name } = ghRepo(repo);
    const threads: RawReviewThread[] = [];
    let cursor: string | null = null;
    do {
      const res = (await withRetry(
        () =>
          this.gql(REVIEW_THREADS_QUERY, {
            owner,
            repo: name,
            number: prNumber,
            cursor,
          }),
        { shouldRetry: isTransientForgeError }
      )) as {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: RawReviewThread[];
            };
          };
        };
      };
      const page = res.repository.pullRequest.reviewThreads;
      threads.push(...page.nodes);
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return threads;
  }

  // Resolves the review-thread node id for a freshly created review comment so
  // the thread can be resolved later. Shared by inline comments and suggestions.
  private async threadResultForComment(
    repo: RepoRef,
    prNumber: number,
    commentDbId: number
  ): Promise<InlineCommentResult> {
    const threads = await this.fetchThreads(repo, prNumber);
    const thread = threads.find((t) =>
      t.comments.nodes.some((c) => c.databaseId === commentDbId)
    );
    if (!thread) {
      throw new Error(
        `Created review comment ${commentDbId} but could not locate its review thread`
      );
    }
    return { threadId: thread.id, noteId: String(commentDbId) };
  }

  async createInlineComment(
    repo: RepoRef,
    prNumber: number,
    target: InlineTarget,
    body: string
  ): Promise<InlineCommentResult | null> {
    // Findings reference new-side lines; only place when the line is in the diff.
    if (!parseDiffHunks(target.diff).has(target.newLine)) return null;
    const commitId = await this.headShaFor(repo, prNumber);

    const { data } = await withRetry(
      () =>
        this.octokit.rest.pulls.createReviewComment({
          ...ghRepo(repo),
          pull_number: prNumber,
          commit_id: commitId,
          path: target.path,
          line: target.newLine,
          side: "RIGHT",
          body,
        }),
      { shouldRetry: isTransientForgeError }
    );
    return this.threadResultForComment(repo, prNumber, data.id);
  }

  async createSuggestionComment(
    repo: RepoRef,
    prNumber: number,
    target: SuggestionTarget,
    explanation: string,
    replacementLines: string[]
  ): Promise<InlineCommentResult | null> {
    if (target.startLine > target.endLine) {
      throw new Error(
        `Invalid suggestion range: startLine ${target.startLine} > endLine ${target.endLine}`
      );
    }
    // GitHub 422s when the multi-line range leaves the hunk, so require every
    // line in [startLine, endLine] to be present in the diff.
    const hunks = parseDiffHunks(target.diff);
    for (let line = target.startLine; line <= target.endLine; line++) {
      if (!hunks.has(line)) return null;
    }
    const commitId = await this.headShaFor(repo, prNumber);
    const body =
      `${explanation}\n\n` +
      `\`\`\`suggestion\n${replacementLines.join("\n")}\n\`\`\``;

    const { data } = await withRetry(
      () =>
        this.octokit.rest.pulls.createReviewComment({
          ...ghRepo(repo),
          pull_number: prNumber,
          commit_id: commitId,
          path: target.path,
          line: target.endLine,
          side: "RIGHT",
          ...(target.endLine > target.startLine
            ? { start_line: target.startLine, start_side: "RIGHT" as const }
            : {}),
          body,
        }),
      { shouldRetry: isTransientForgeError }
    );
    return this.threadResultForComment(repo, prNumber, data.id);
  }

  async createSummaryComment(
    repo: RepoRef,
    prNumber: number,
    body: string
  ): Promise<string> {
    const { data } = await this.octokit.rest.issues.createComment({
      ...ghRepo(repo),
      issue_number: prNumber,
      body,
    });
    return String(data.id);
  }

  private async findSummaryComment(
    repo: RepoRef,
    prNumber: number,
    marker: string
  ): Promise<{ id: number; body?: string } | undefined> {
    const comments = (await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      { ...ghRepo(repo), issue_number: prNumber, per_page: 100 }
    )) as Array<{ id: number; body?: string }>;
    return comments.find((c) => c.body?.includes(marker));
  }

  async getSummaryComment(
    repo: RepoRef,
    prNumber: number,
    marker: string
  ): Promise<string | null> {
    const existing = await this.findSummaryComment(repo, prNumber, marker);
    return existing?.body ?? null;
  }

  async upsertSummaryComment(
    repo: RepoRef,
    prNumber: number,
    marker: string,
    body: string
  ): Promise<string> {
    const finalBody = body.includes(marker) ? body : `${body}\n\n${marker}`;
    const existing = await this.findSummaryComment(repo, prNumber, marker);
    if (existing) {
      await this.octokit.rest.issues.updateComment({
        ...ghRepo(repo),
        comment_id: existing.id,
        body: finalBody,
      });
      return String(existing.id);
    }
    const { data } = await this.octokit.rest.issues.createComment({
      ...ghRepo(repo),
      issue_number: prNumber,
      body: finalBody,
    });
    return String(data.id);
  }

  async resolveThread(
    _repo: RepoRef,
    _prNumber: number,
    threadId: string,
    resolved: boolean
  ): Promise<void> {
    await this.gql(resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { threadId });
  }

  async addReply(
    repo: RepoRef,
    prNumber: number,
    _threadId: string,
    noteId: string,
    body: string
  ): Promise<void> {
    await this.octokit.rest.pulls.createReplyForReviewComment({
      ...ghRepo(repo),
      pull_number: prNumber,
      comment_id: Number(noteId),
      body,
    });
  }

  async getThreads(repo: RepoRef, prNumber: number): Promise<Thread[]> {
    const threads = await this.fetchThreads(repo, prNumber);
    return threads.map((t) => ({
      id: t.id,
      notes: t.comments.nodes.map((c) => ({
        id: String(c.databaseId),
        body: c.body,
        authorUsername: c.author?.login ?? "",
      })),
    }));
  }

  async addLabel(repo: RepoRef, prNumber: number, label: string): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      ...ghRepo(repo),
      issue_number: prNumber,
      labels: [label],
    });
  }

  async removeLabel(repo: RepoRef, prNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        ...ghRepo(repo),
        issue_number: prNumber,
        name: label,
      });
    } catch (err) {
      // GitHub 404s when the label isn't present; GitLab's removeLabel is a no-op
      // in that case, so swallow 404 to keep behavior identical across forges.
      const status = (err as { status?: number })?.status;
      if (status !== 404) throw err;
    }
  }
}
