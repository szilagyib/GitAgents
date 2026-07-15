import { describe, it, expect } from "vitest";
import { detectForgeKind, buildRepoRef } from "../src/factory";

describe("detectForgeKind", () => {
  it("honors an explicit override", () => {
    expect(detectForgeKind("github", {})).toBe("github");
    expect(detectForgeKind("gitlab", { GITHUB_ACTIONS: "true" })).toBe("gitlab");
  });
  it("detects GitHub from GITHUB_ACTIONS", () => {
    expect(detectForgeKind("", { GITHUB_ACTIONS: "true" })).toBe("github");
  });
  it("detects GitLab from GITLAB_CI", () => {
    expect(detectForgeKind("", { GITLAB_CI: "true" })).toBe("gitlab");
  });
  it("defaults to gitlab when ambiguous", () => {
    expect(detectForgeKind("", {})).toBe("gitlab");
  });
});

describe("buildRepoRef", () => {
  it("builds a github ref from GITHUB_REPOSITORY", () => {
    const ref = buildRepoRef("github", { GITHUB_REPOSITORY: "octo/hello" }, 0);
    expect(ref).toEqual({ forge: "github", owner: "octo", repo: "hello", slug: "octo/hello" });
  });
  it("builds a gitlab ref from a numeric project id and slug", () => {
    const ref = buildRepoRef("gitlab", { CI_PROJECT_PATH: "grp/proj" }, 123);
    expect(ref).toEqual({ forge: "gitlab", projectId: 123, slug: "grp/proj" });
  });
  it("throws when github repo is missing", () => {
    expect(() => buildRepoRef("github", {}, 0)).toThrow(/GITHUB_REPOSITORY/);
  });
});
