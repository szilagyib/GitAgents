import { describe, it, expect, vi, beforeEach } from "vitest";

const restMocks = {
  pulls: {
    get: vi.fn(),
    listFiles: vi.fn(),
    createReviewComment: vi.fn(),
    createReplyForReviewComment: vi.fn(),
  },
  repos: { getContent: vi.fn() },
  issues: {
    createComment: vi.fn(),
    listComments: vi.fn(),
    updateComment: vi.fn(),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
  },
};
const paginateMock = vi.fn();
const graphqlMock = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: restMocks,
    paginate: paginateMock,
  })),
}));
vi.mock("@octokit/graphql", () => ({
  graphql: { defaults: vi.fn(() => graphqlMock) },
}));

import { GitHubForge } from "../src/github";
import type { RepoRef } from "../src/types";

const repo: RepoRef = { forge: "github", owner: "o", repo: "r", slug: "o/r" };
const DIFF = "@@ -1,3 +1,4 @@\n line1\n+line2\n line3";

describe("GitHubForge", () => {
  let forge: GitHubForge;
  beforeEach(() => {
    vi.clearAllMocks();
    forge = new GitHubForge("https://api.github.com", "tok");
  });

  it("maps PR info", async () => {
    restMocks.pulls.get.mockResolvedValue({
      data: {
        number: 42,
        head: { ref: "feature", sha: "head" },
        base: { ref: "master", sha: "base" },
        labels: [{ name: "x" }],
      },
    });
    const info = await forge.getPullRequest(repo, 42);
    expect(info.number).toBe(42);
    expect(info.sourceBranch).toBe("feature");
    expect(info.targetBranch).toBe("master");
    expect(info.headSha).toBe("head");
    expect(info.diffRefs).toEqual({ baseSha: "base", startSha: "base", headSha: "head" });
    expect(info.labels).toEqual(["x"]);
  });

  it("maps listFiles to FileDiff", async () => {
    paginateMock.mockResolvedValue([
      { filename: "src/App.ts", patch: DIFF, status: "modified" },
      { filename: "new.ts", previous_filename: "old.ts", patch: "", status: "renamed" },
    ]);
    const diffs = await forge.getDiffs(repo, 42);
    expect(diffs[0]).toMatchObject({ newPath: "src/App.ts", newFile: false, deletedFile: false });
    expect(diffs[1]).toMatchObject({ oldPath: "old.ts", newPath: "new.ts", renamedFile: true });
  });

  it("decodes base64 file content", async () => {
    restMocks.repos.getContent.mockResolvedValue({
      data: { content: "ZmlsZSBjb250ZW50", encoding: "base64", type: "file" },
    });
    expect(await forge.getFileContent(repo, "src/App.ts", "feature")).toBe("file content");
  });

  it("creates inline comment and looks up its thread id", async () => {
    restMocks.pulls.get.mockResolvedValue({
      data: { number: 42, head: { ref: "f", sha: "headsha" }, base: { ref: "m", sha: "b" }, labels: [] },
    });
    restMocks.pulls.createReviewComment.mockResolvedValue({ data: { id: 555 } });
    graphqlMock.mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { id: "THREAD1", isResolved: false, comments: { nodes: [{ databaseId: 555, body: "x", author: { login: "bot" } }] } },
            ],
          },
        },
      },
    });
    const res = await forge.createInlineComment(repo, 42, { path: "src/App.ts", newLine: 2, diff: DIFF }, "issue");
    expect(restMocks.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", pull_number: 42, commit_id: "headsha", path: "src/App.ts", line: 2, side: "RIGHT", body: "issue" })
    );
    expect(res).toEqual({ threadId: "THREAD1", noteId: "555" });
  });

  it("returns null when the line is not in the diff", async () => {
    const res = await forge.createInlineComment(repo, 42, { path: "src/App.ts", newLine: 999, diff: DIFF }, "issue");
    expect(res).toBeNull();
    expect(restMocks.pulls.createReviewComment).not.toHaveBeenCalled();
  });

  it("creates a summary comment", async () => {
    restMocks.issues.createComment.mockResolvedValue({ data: { id: 88 } });
    expect(await forge.createSummaryComment(repo, 42, "body")).toBe("88");
  });

  it("resolves a thread via graphql", async () => {
    graphqlMock.mockResolvedValue({ resolveReviewThread: { thread: { id: "T", isResolved: true } } });
    await forge.resolveThread(repo, 42, "T", true);
    expect(graphqlMock).toHaveBeenCalledWith(expect.stringContaining("resolveReviewThread"), { threadId: "T" });
  });

  it("unresolves a thread via graphql", async () => {
    graphqlMock.mockResolvedValue({ unresolveReviewThread: { thread: { id: "T", isResolved: false } } });
    await forge.resolveThread(repo, 42, "T", false);
    expect(graphqlMock).toHaveBeenCalledWith(expect.stringContaining("unresolveReviewThread"), { threadId: "T" });
  });

  it("adds a reply by comment databaseId", async () => {
    restMocks.pulls.createReplyForReviewComment.mockResolvedValue({ data: {} });
    await forge.addReply(repo, 42, "T", "555", "reply");
    expect(restMocks.pulls.createReplyForReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", pull_number: 42, comment_id: 555, body: "reply" })
    );
  });

  it("maps threads from graphql", async () => {
    graphqlMock.mockResolvedValue({
      repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { id: "t1", isResolved: false, comments: { nodes: [{ databaseId: 9, body: "hi", author: { login: "bot" } }] } },
        ],
      } } },
    });
    const threads = await forge.getThreads(repo, 42);
    expect(threads[0]).toEqual({ id: "t1", notes: [{ id: "9", body: "hi", authorUsername: "bot" }] });
  });

  it("pages through every review thread", async () => {
    // Dedup markers live on old threads; truncating at 100 silently reintroduces
    // duplicate inline comments on busy PRs.
    const thread = (id: string, dbId: number) => ({
      id,
      isResolved: false,
      comments: { nodes: [{ databaseId: dbId, body: id, author: { login: "bot" } }] },
    });
    graphqlMock
      .mockResolvedValueOnce({
        repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: true, endCursor: "CURSOR1" },
          nodes: [thread("t1", 1)],
        } } },
      })
      .mockResolvedValueOnce({
        repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [thread("t2", 2)],
        } } },
      });

    const threads = await forge.getThreads(repo, 42);

    expect(threads.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(graphqlMock).toHaveBeenCalledTimes(2);
    expect(graphqlMock).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ cursor: null }));
    expect(graphqlMock).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ cursor: "CURSOR1" }));
  });

  it("points graphql at the /api root on GitHub Enterprise Server", async () => {
    const { graphql } = await import("@octokit/graphql");
    (graphql.defaults as any).mockClear();
    new GitHubForge("https://ghe.corp/api/v3", "tok");
    expect(graphql.defaults).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://ghe.corp/api" })
    );
  });

  it("leaves the github.com graphql base url alone", async () => {
    const { graphql } = await import("@octokit/graphql");
    (graphql.defaults as any).mockClear();
    new GitHubForge("https://api.github.com", "tok");
    expect(graphql.defaults).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://api.github.com" })
    );
  });

  describe("getSummaryComment", () => {
    const marker = "<!-- gitagents:summary:fix -->";

    it("returns the body of the note carrying the marker", async () => {
      paginateMock.mockResolvedValue([
        { id: 3, body: "unrelated" },
        { id: 77, body: `fix summary\n\n${marker}` },
      ]);
      expect(await forge.getSummaryComment(repo, 42, marker)).toBe(`fix summary\n\n${marker}`);
    });

    it("returns null when no note carries the marker", async () => {
      paginateMock.mockResolvedValue([{ id: 3, body: "unrelated" }]);
      expect(await forge.getSummaryComment(repo, 42, marker)).toBeNull();
    });
  });

  it("adds and removes labels", async () => {
    restMocks.issues.addLabels.mockResolvedValue({ data: [] });
    restMocks.issues.removeLabel.mockResolvedValue({ data: [] });
    await forge.addLabel(repo, 42, "lbl");
    expect(restMocks.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42, labels: ["lbl"] }));
    await forge.removeLabel(repo, 42, "lbl");
    expect(restMocks.issues.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42, name: "lbl" }));
  });

  it("swallows a 404 when removing a missing label", async () => {
    restMocks.issues.removeLabel.mockRejectedValue({ status: 404 });
    await expect(forge.removeLabel(repo, 42, "lbl")).resolves.toBeUndefined();
  });

  it("rethrows non-404 errors from removeLabel", async () => {
    restMocks.issues.removeLabel.mockRejectedValue({ status: 500 });
    await expect(forge.removeLabel(repo, 42, "lbl")).rejects.toEqual({ status: 500 });
  });

  describe("upsertSummaryComment", () => {
    const marker = "<!-- gitagents:summary -->";

    it("edits the existing comment carrying the marker", async () => {
      paginateMock.mockResolvedValue([
        { id: 3, body: "unrelated" },
        { id: 77, body: `old summary\n\n${marker}` },
      ]);
      restMocks.issues.updateComment.mockResolvedValue({ data: { id: 77 } });
      const id = await forge.upsertSummaryComment(repo, 42, marker, `new summary\n\n${marker}`);
      expect(paginateMock).toHaveBeenCalledWith(
        restMocks.issues.listComments,
        expect.objectContaining({ owner: "o", repo: "r", issue_number: 42, per_page: 100 })
      );
      expect(restMocks.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "o", repo: "r", comment_id: 77, body: `new summary\n\n${marker}` })
      );
      expect(restMocks.issues.createComment).not.toHaveBeenCalled();
      expect(id).toBe("77");
    });

    it("creates a comment (with marker appended) when no marker match exists", async () => {
      paginateMock.mockResolvedValue([{ id: 3, body: "unrelated" }]);
      restMocks.issues.createComment.mockResolvedValue({ data: { id: 88 } });
      const id = await forge.upsertSummaryComment(repo, 42, marker, "summary without marker");
      expect(restMocks.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 42, body: `summary without marker\n\n${marker}` })
      );
      expect(restMocks.issues.updateComment).not.toHaveBeenCalled();
      expect(id).toBe("88");
    });
  });

  describe("createSuggestionComment", () => {
    beforeEach(() => {
      restMocks.pulls.get.mockResolvedValue({
        data: { number: 42, head: { ref: "f", sha: "headsha" }, base: { ref: "m", sha: "b" }, labels: [] },
      });
      restMocks.pulls.createReviewComment.mockResolvedValue({ data: { id: 600 } });
      graphqlMock.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { id: "THREAD2", isResolved: false, comments: { nodes: [{ databaseId: 600, body: "x", author: { login: "bot" } }] } },
              ],
            },
          },
        },
      });
    });

    it("posts a single-line suggestion without start_line", async () => {
      const res = await forge.createSuggestionComment(
        repo,
        42,
        { path: "src/App.ts", startLine: 2, endLine: 2, diff: DIFF },
        "explain",
        ["replacement"]
      );
      const arg = restMocks.pulls.createReviewComment.mock.calls[0][0];
      expect(arg).toMatchObject({
        owner: "o",
        repo: "r",
        pull_number: 42,
        commit_id: "headsha",
        path: "src/App.ts",
        line: 2,
        side: "RIGHT",
      });
      expect(arg).not.toHaveProperty("start_line");
      expect(arg).not.toHaveProperty("start_side");
      expect(arg.body).toBe("explain\n\n```suggestion\nreplacement\n```");
      expect(res).toEqual({ threadId: "THREAD2", noteId: "600" });
    });

    it("posts a multi-line suggestion with start_line/start_side", async () => {
      const res = await forge.createSuggestionComment(
        repo,
        42,
        { path: "src/App.ts", startLine: 1, endLine: 3, diff: DIFF },
        "explain",
        ["alpha", "beta"]
      );
      expect(restMocks.pulls.createReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({
          line: 3,
          side: "RIGHT",
          start_line: 1,
          start_side: "RIGHT",
          body: "explain\n\n```suggestion\nalpha\nbeta\n```",
        })
      );
      expect(res).toEqual({ threadId: "THREAD2", noteId: "600" });
    });

    it("returns null when any line of the range is outside the diff", async () => {
      const res = await forge.createSuggestionComment(
        repo,
        42,
        { path: "src/App.ts", startLine: 2, endLine: 4, diff: DIFF },
        "explain",
        ["alpha"]
      );
      expect(res).toBeNull();
      expect(restMocks.pulls.createReviewComment).not.toHaveBeenCalled();
    });

    it("throws when startLine > endLine", async () => {
      await expect(
        forge.createSuggestionComment(
          repo,
          42,
          { path: "src/App.ts", startLine: 3, endLine: 1, diff: DIFF },
          "explain",
          ["alpha"]
        )
      ).rejects.toThrow(/startLine/);
    });
  });
});
