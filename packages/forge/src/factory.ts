import { GitLabForge } from "./gitlab.js";
import { GitHubForge } from "./github.js";
import type { Forge, RepoRef } from "./types.js";

export type ForgeKind = "gitlab" | "github";

type Env = Record<string, string | undefined>;

export function detectForgeKind(override: string, env: Env): ForgeKind {
  if (override === "github" || override === "gitlab") return override;
  if (env.GITHUB_ACTIONS === "true") return "github";
  if (env.GITLAB_CI === "true") return "gitlab";
  return "gitlab";
}

export function buildRepoRef(
  kind: ForgeKind,
  env: Env,
  projectId: number
): RepoRef {
  if (kind === "github") {
    const full = env.GITHUB_REPOSITORY ?? "";
    const [owner, repo] = full.split("/");
    if (!owner || !repo) {
      throw new Error(
        "GITHUB_REPOSITORY (owner/repo) is required for the GitHub forge"
      );
    }
    return { forge: "github", owner, repo, slug: full };
  }
  return {
    forge: "gitlab",
    projectId,
    slug: env.CI_PROJECT_PATH ?? String(projectId),
  };
}

export interface CreateForgeOptions {
  override: string; // value of --forge, or ""
  env: Env;
  token: string;
  apiBaseUrl: string; // GitLab host URL, or GitHub API base
  projectId: number; // used only for the gitlab ref
}

export interface CreatedForge {
  forge: Forge;
  repo: RepoRef;
  kind: ForgeKind;
}

export function createForge(opts: CreateForgeOptions): CreatedForge {
  const kind = detectForgeKind(opts.override, opts.env);
  const repo = buildRepoRef(kind, opts.env, opts.projectId);
  const forge =
    kind === "github"
      ? new GitHubForge(opts.apiBaseUrl, opts.token)
      : new GitLabForge(opts.apiBaseUrl, opts.token);
  return { forge, repo, kind };
}
