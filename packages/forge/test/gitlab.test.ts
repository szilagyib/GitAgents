import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { GitLabForge } from "../src/gitlab";
import type { RepoRef } from "../src/types";
import { Gitlab } from "@gitbeaker/rest";

const repo: RepoRef = { forge: "gitlab", projectId: 123, slug: "grp/proj" };

vi.mock("@gitbeaker/rest", () => ({
  Gitlab: vi.fn().mockImplementation(() => ({
    MergeRequests: {
      show: vi.fn().mockResolvedValue({
        iid: 42,
        source_branch: "feature",
        target_branch: "master",
        labels: ["x"],
        sha: "head",
        diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
      }),
      allDiffs: vi.fn().mockResolvedValue([
        {
          old_path: "src/App.ts",
          new_path: "src/App.ts",
          diff: "@@ -1,3 +1,4 @@\n line1\n+line2\n line3",
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ]),
      edit: vi.fn().mockResolvedValue({}),
    },
    MergeRequestDiscussions: {
      create: vi.fn().mockResolvedValue({ id: "disc1", notes: [{ id: 7 }] }),
      addNote: vi.fn().mockResolvedValue({}),
      resolve: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue([
        { id: "d1", notes: [{ id: 9, body: "hi", author: { username: "bot" } }] },
      ]),
    },
    MergeRequestNotes: {
      create: vi.fn().mockResolvedValue({ id: 5 }),
      all: vi.fn().mockResolvedValue([]),
      edit: vi.fn().mockResolvedValue({}),
    },
    RepositoryFiles: {
      show: vi
        .fn()
        .mockResolvedValue({ content: "ZmlsZSBjb250ZW50", encoding: "base64" }),
    },
  })),
}));

describe("GitLabForge", () => {
  let forge: GitLabForge;
  // The api instance created by the mocked Gitlab constructor for this test.
  let api: any;
  beforeEach(() => {
    forge = new GitLabForge("https://gitlab.example.com", "tok");
    api = (Gitlab as unknown as Mock).mock.results.at(-1)!.value;
  });

  it("maps PR info", async () => {
    const info = await forge.getPullRequest(repo, 42);
    expect(info.number).toBe(42);
    expect(info.targetBranch).toBe("master");
    expect(info.headSha).toBe("head");
    expect(info.diffRefs.baseSha).toBe("base");
  });

  it("maps diffs to camelCase", async () => {
    const diffs = await forge.getDiffs(repo, 42);
    expect(diffs[0].newPath).toBe("src/App.ts");
    expect(diffs[0].newFile).toBe(false);
  });

  it("decodes base64 file content", async () => {
    const content = await forge.getFileContent(repo, "src/App.ts", "feature");
    expect(content).toBe("file content");
  });

  it("creates an inline comment with string ids", async () => {
    await forge.getPullRequest(repo, 42); // populate refs cache
    const res = await forge.createInlineComment(
      repo,
      42,
      { path: "src/App.ts", newLine: 2, diff: "@@ -1,3 +1,4 @@\n line1\n+line2\n line3" },
      "issue"
    );
    expect(res).toEqual({ threadId: "disc1", noteId: "7" });
  });

  it("returns null when the line is not in the diff", async () => {
    await forge.getPullRequest(repo, 42);
    const res = await forge.createInlineComment(
      repo,
      42,
      { path: "src/App.ts", newLine: 999, diff: "@@ -1,3 +1,4 @@\n line1\n+line2\n line3" },
      "issue"
    );
    expect(res).toBeNull();
  });

  it("maps threads", async () => {
    const threads = await forge.getThreads(repo, 42);
    expect(threads[0].id).toBe("d1");
    expect(threads[0].notes[0]).toEqual({ id: "9", body: "hi", authorUsername: "bot" });
  });

  describe("upsertSummaryComment", () => {
    const marker = "<!-- gitagents:summary -->";

    it("edits the existing note carrying the marker", async () => {
      api.MergeRequestNotes.all.mockResolvedValue([
        { id: 3, system: false, body: "unrelated note" },
        { id: 11, system: false, body: `old summary\n\n${marker}` },
      ]);
      const id = await forge.upsertSummaryComment(repo, 42, marker, `new summary\n\n${marker}`);
      expect(api.MergeRequestNotes.edit).toHaveBeenCalledWith(123, 42, 11, {
        body: `new summary\n\n${marker}`,
      });
      expect(api.MergeRequestNotes.create).not.toHaveBeenCalled();
      expect(id).toBe("11");
    });

    it("creates a note when no marker match exists", async () => {
      api.MergeRequestNotes.all.mockResolvedValue([
        { id: 3, system: false, body: "unrelated note" },
      ]);
      const id = await forge.upsertSummaryComment(repo, 42, marker, `summary\n\n${marker}`);
      expect(api.MergeRequestNotes.create).toHaveBeenCalledWith(123, 42, `summary\n\n${marker}`);
      expect(api.MergeRequestNotes.edit).not.toHaveBeenCalled();
      expect(id).toBe("5");
    });

    it("appends the marker when the body lacks it", async () => {
      api.MergeRequestNotes.all.mockResolvedValue([]);
      await forge.upsertSummaryComment(repo, 42, marker, "summary without marker");
      expect(api.MergeRequestNotes.create).toHaveBeenCalledWith(
        123,
        42,
        `summary without marker\n\n${marker}`
      );
    });

    it("skips system notes even when their body matches", async () => {
      api.MergeRequestNotes.all.mockResolvedValue([
        { id: 1, system: true, body: `system echo ${marker}` },
      ]);
      await forge.upsertSummaryComment(repo, 42, marker, `summary\n\n${marker}`);
      expect(api.MergeRequestNotes.edit).not.toHaveBeenCalled();
      expect(api.MergeRequestNotes.create).toHaveBeenCalled();
    });
  });

  describe("createSuggestionComment", () => {
    const DIFF = "@@ -1,3 +1,4 @@\n line1\n+line2\n line3";

    it("posts a positioned suggestion covering the range", async () => {
      const res = await forge.createSuggestionComment(
        repo,
        42,
        { path: "src/App.ts", startLine: 1, endLine: 3, diff: DIFF },
        "fix it",
        ["alpha", "beta", "gamma"]
      );
      expect(api.MergeRequestDiscussions.create).toHaveBeenCalledWith(
        123,
        42,
        "fix it\n\n```suggestion:-0+2\nalpha\nbeta\ngamma\n```",
        expect.objectContaining({
          position: expect.objectContaining({
            new_path: "src/App.ts",
            new_line: 1,
            old_line: 1,
            position_type: "text",
          }),
        })
      );
      expect(res).toEqual({ threadId: "disc1", noteId: "7" });
    });

    it("returns null when startLine is not in the diff", async () => {
      const res = await forge.createSuggestionComment(
        repo,
        42,
        { path: "src/App.ts", startLine: 999, endLine: 999, diff: DIFF },
        "fix it",
        ["alpha"]
      );
      expect(res).toBeNull();
      expect(api.MergeRequestDiscussions.create).not.toHaveBeenCalled();
    });

    it("throws when startLine > endLine", async () => {
      await expect(
        forge.createSuggestionComment(
          repo,
          42,
          { path: "src/App.ts", startLine: 3, endLine: 1, diff: DIFF },
          "fix it",
          ["alpha"]
        )
      ).rejects.toThrow(/startLine/);
    });
  });
});
