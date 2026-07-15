import { Gitlab } from "@gitbeaker/rest";
import { withRetry } from "@gitagents/core";
import { parseDiffHunks, type DiffLineInfo } from "./diff.js";
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

function projectId(repo: RepoRef): number {
  if (repo.forge !== "gitlab") {
    throw new Error(`GitLabForge received a non-gitlab RepoRef: ${repo.forge}`);
  }
  return repo.projectId;
}

export class GitLabForge implements Forge {
  private api: InstanceType<typeof Gitlab>;
  private refsCache = new Map<number, PullRequestInfo["diffRefs"]>();

  constructor(host: string, token: string) {
    this.api = new Gitlab({ host, token });
  }

  async getPullRequest(repo: RepoRef, prNumber: number): Promise<PullRequestInfo> {
    const mr = (await this.api.MergeRequests.show(projectId(repo), prNumber)) as any;
    const diffRefs = {
      baseSha: mr.diff_refs.base_sha,
      startSha: mr.diff_refs.start_sha,
      headSha: mr.diff_refs.head_sha,
    };
    this.refsCache.set(prNumber, diffRefs);
    return {
      number: mr.iid,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      labels: mr.labels ?? [],
      headSha: mr.sha,
      diffRefs,
    };
  }

  async getDiffs(repo: RepoRef, prNumber: number): Promise<FileDiff[]> {
    const diffs = (await this.api.MergeRequests.allDiffs(
      projectId(repo),
      prNumber
    )) as any[];
    return diffs.map((d) => ({
      oldPath: d.old_path,
      newPath: d.new_path,
      diff: d.diff,
      newFile: d.new_file,
      renamedFile: d.renamed_file,
      deletedFile: d.deleted_file,
    }));
  }

  async getFileContent(repo: RepoRef, path: string, ref: string): Promise<string> {
    const file = (await this.api.RepositoryFiles.show(
      projectId(repo),
      path,
      ref
    )) as { content: string; encoding: string };
    if (file.encoding === "base64") {
      return Buffer.from(file.content, "base64").toString("utf-8");
    }
    return file.content;
  }

  private async refsFor(
    repo: RepoRef,
    prNumber: number
  ): Promise<PullRequestInfo["diffRefs"]> {
    const cached = this.refsCache.get(prNumber);
    if (cached) return cached;
    await this.getPullRequest(repo, prNumber);
    return this.refsCache.get(prNumber)!;
  }

  // Creates a positioned discussion anchored at `newLine` and returns its ids.
  // Shared by inline comments and suggestions so the position/refs logic lives
  // in one place.
  private async createPositionedDiscussion(
    repo: RepoRef,
    prNumber: number,
    path: string,
    newLine: number,
    info: DiffLineInfo,
    body: string
  ): Promise<InlineCommentResult> {
    const refs = await this.refsFor(repo, prNumber);
    const position: Record<string, unknown> = {
      base_sha: refs.baseSha,
      start_sha: refs.startSha,
      head_sha: refs.headSha,
      position_type: "text",
      new_path: path,
      new_line: newLine,
    };
    if (info.kind === "context") position.old_line = info.oldLine;

    const discussion = (await withRetry(
      () =>
        this.api.MergeRequestDiscussions.create(
          projectId(repo),
          prNumber,
          body,
          { position } as any
        ),
      { shouldRetry: isTransientForgeError }
    )) as { id: string; notes?: Array<{ id: number }> };

    if (!discussion.notes || discussion.notes.length === 0) {
      throw new Error(
        `Created discussion ${discussion.id} has no notes; cannot return noteId`
      );
    }
    return { threadId: discussion.id, noteId: String(discussion.notes[0].id) };
  }

  async createInlineComment(
    repo: RepoRef,
    prNumber: number,
    target: InlineTarget,
    body: string
  ): Promise<InlineCommentResult | null> {
    const info = parseDiffHunks(target.diff).get(target.newLine);
    if (!info) return null;
    return this.createPositionedDiscussion(
      repo,
      prNumber,
      target.path,
      target.newLine,
      info,
      body
    );
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
    // GitLab anchors the suggestion at startLine and shifts down via the fence
    // header, so only the anchor line needs to be present in the diff.
    const info = parseDiffHunks(target.diff).get(target.startLine);
    if (!info) return null;
    const span = target.endLine - target.startLine;
    const body =
      `${explanation}\n\n` +
      `\`\`\`suggestion:-0+${span}\n${replacementLines.join("\n")}\n\`\`\``;
    return this.createPositionedDiscussion(
      repo,
      prNumber,
      target.path,
      target.startLine,
      info,
      body
    );
  }

  async createSummaryComment(
    repo: RepoRef,
    prNumber: number,
    body: string
  ): Promise<string> {
    const note = (await this.api.MergeRequestNotes.create(
      projectId(repo),
      prNumber,
      body
    )) as { id: number };
    return String(note.id);
  }

  private async findSummaryNote(
    repo: RepoRef,
    prNumber: number,
    marker: string
  ): Promise<{ id: number; body?: string } | undefined> {
    // perPage keeps the marker note findable on long MRs (default page is 20).
    const notes = (await this.api.MergeRequestNotes.all(
      projectId(repo),
      prNumber,
      { perPage: 100 } as any
    )) as Array<{ id: number; body?: string; system?: boolean }>;
    return notes.find(
      (note) =>
        !note.system &&
        typeof note.body === "string" &&
        note.body.includes(marker)
    );
  }

  async getSummaryComment(
    repo: RepoRef,
    prNumber: number,
    marker: string
  ): Promise<string | null> {
    const existing = await this.findSummaryNote(repo, prNumber, marker);
    return existing?.body ?? null;
  }

  async upsertSummaryComment(
    repo: RepoRef,
    prNumber: number,
    marker: string,
    body: string
  ): Promise<string> {
    const finalBody = body.includes(marker) ? body : `${body}\n\n${marker}`;
    const existing = await this.findSummaryNote(repo, prNumber, marker);
    if (existing) {
      await this.api.MergeRequestNotes.edit(
        projectId(repo),
        prNumber,
        existing.id,
        { body: finalBody }
      );
      return String(existing.id);
    }
    const note = (await this.api.MergeRequestNotes.create(
      projectId(repo),
      prNumber,
      finalBody
    )) as { id: number };
    return String(note.id);
  }

  async resolveThread(
    repo: RepoRef,
    prNumber: number,
    threadId: string,
    resolved: boolean
  ): Promise<void> {
    await this.api.MergeRequestDiscussions.resolve(
      projectId(repo),
      prNumber,
      threadId,
      resolved
    );
  }

  async addReply(
    repo: RepoRef,
    prNumber: number,
    threadId: string,
    noteId: string,
    body: string
  ): Promise<void> {
    await this.api.MergeRequestDiscussions.addNote(
      projectId(repo),
      prNumber,
      threadId,
      Number(noteId),
      body
    );
  }

  async getThreads(repo: RepoRef, prNumber: number): Promise<Thread[]> {
    const discussions = (await withRetry(
      () => this.api.MergeRequestDiscussions.all(projectId(repo), prNumber),
      { shouldRetry: isTransientForgeError }
    )) as Array<{
      id: string;
      notes?: Array<{ id: number; body: string; author: { username: string } }>;
    }>;
    return discussions.map((d) => ({
      id: d.id,
      notes: (d.notes ?? []).map((n) => ({
        id: String(n.id),
        body: n.body,
        authorUsername: n.author.username,
      })),
    }));
  }

  async addLabel(repo: RepoRef, prNumber: number, label: string): Promise<void> {
    await this.api.MergeRequests.edit(projectId(repo), prNumber, {
      addLabels: label,
    });
  }

  async removeLabel(repo: RepoRef, prNumber: number, label: string): Promise<void> {
    await this.api.MergeRequests.edit(projectId(repo), prNumber, {
      removeLabels: label,
    });
  }
}
