import {
  createLlmClient,
  DashboardTelemetryRecorder,
  loadRules,
  loadPersonality,
  loadReviewContext,
  isReviewArtifact,
  type ReviewArtifact,
  type CommentMap,
} from "@gitagents/core";
import {
  createForge,
  type Thread,
} from "@gitagents/forge";
import { orchestrateReview } from "./orchestrator.js";
import {
  classifyFindings,
  buildUpdatedCommentMap,
  buildPreviousMapFromThreads,
  findingMarker,
  type ReconciliationAction,
} from "./reconciler.js";
import { applySuppressions } from "./suppressions.js";
import { computeBlocking } from "./severity-policy.js";
import { planInlineComments } from "./inline-plan.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const REVIEW_SUMMARY_MARKER = "<!-- gitagents:summary:review -->";
const DEFAULT_MAX_INLINE_COMMENTS = 15;

interface CliArgs {
  prNumber: number;
  projectId: number; // gitlab numeric id (0 for github)
  forge: string; // explicit override or ""
  configDir: string;
  repoDir: string;
  artifactPath: string;
  apiBaseUrl: string;
  token: string;
  contextWindowSize: number;
  apiTimeoutMs: number;
  maxDiffLines: number;
  maxInlineComments: number;
  telemetryEnabled: boolean;
  dashboardUrl: string;
}

function parseArgs(argv: string[]): CliArgs {
  const getArg = (name: string, defaultValue: string): string => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : defaultValue;
  };

  const forge = getArg("forge", "");
  const isGithub =
    forge === "github" ||
    (forge === "" && process.env.GITHUB_ACTIONS === "true");
  const prNumber = parseInt(
    getArg("pr", getArg("mr-id", process.env.CI_MERGE_REQUEST_IID ?? "0")),
    10
  );
  const apiBaseUrl = isGithub
    ? process.env.GITHUB_API_URL || "https://api.github.com"
    : process.env.CI_SERVER_URL || getArg("gitlab-url", "https://gitlab.com");
  const token = isGithub
    ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ""
    : process.env.GITLAB_TOKEN || "";

  return {
    prNumber,
    projectId: parseInt(getArg("project-id", process.env.CI_PROJECT_ID ?? "0"), 10),
    forge,
    configDir: getArg("config-dir", resolve(process.cwd(), "config")),
    repoDir: getArg(
      "repo-dir",
      process.env.CI_PROJECT_DIR || process.env.GITHUB_WORKSPACE || process.cwd()
    ),
    artifactPath: getArg("artifact", "review-result.json"),
    apiBaseUrl,
    token,
    contextWindowSize: parseInt(getArg("context-size", "20"), 10),
    apiTimeoutMs: parseInt(
      process.env.REVIEW_API_TIMEOUT || getArg("api-timeout", "60000"),
      10
    ),
    maxDiffLines: parseInt(getArg("max-diff-lines", "1500"), 10),
    maxInlineComments: parseInt(
      process.env.GITAGENTS_MAX_INLINE_COMMENTS ||
        getArg("max-inline-comments", String(DEFAULT_MAX_INLINE_COMMENTS)),
      10
    ),
    telemetryEnabled:
      process.env.GITAGENTS_TELEMETRY !== "0" &&
      getArg("telemetry", "") !== "off",
    dashboardUrl:
      process.env.GITAGENTS_DASHBOARD_URL ||
      getArg("dashboard-url", ""),
  };
}

export async function runReview(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (!args.prNumber) {
    console.error("Usage: git-agents review --pr <number> [--forge github|gitlab]");
    return 1;
  }

  const { forge, repo } = createForge({
    override: args.forge,
    env: process.env,
    token: args.token,
    apiBaseUrl: args.apiBaseUrl,
    projectId: args.projectId,
  });

  const telemetry = args.telemetryEnabled && args.dashboardUrl
      ? new DashboardTelemetryRecorder({
          dashboardUrl: args.dashboardUrl,
          token: process.env.GITAGENTS_DASHBOARD_TOKEN,
        runId: `review-${repo.slug.replace(/\W+/g, "-")}-${args.prNumber}-${Date.now()}`,
        metadata: {
          repoSlug: repo.slug,
          prNumber: args.prNumber,
          forge: repo.forge,
          agent: "review-agent",
        },
      })
    : undefined;
  const claude = createLlmClient(process.env, {
    telemetry,
    runId: telemetry?.runId,
  });

  const rulesDir = resolve(args.configDir, "rules");
  const { common, languages } = loadRules(rulesDir);
  const personality = loadPersonality(resolve(args.configDir, "personality.md"));
  // review-context.json lives in the CONSUMER repo, not the GitAgents checkout.
  const reviewContext = loadReviewContext(resolve(args.repoDir, "review-context.json"));

  let previousArtifact: ReviewArtifact | null = null;
  if (existsSync(args.artifactPath)) {
    try {
      const raw = JSON.parse(readFileSync(args.artifactPath, "utf-8"));
      if (isReviewArtifact(raw)) {
        previousArtifact = raw;
      }
    } catch {
      // No previous artifact
    }
  }

  const mrInfo = await forge.getPullRequest(repo, args.prNumber);
  const diffs = await forge.getDiffs(repo, args.prNumber);

  const result = await orchestrateReview(
    {
      forge,
      claudeClient: claude,
      repo,
      mrIid: args.prNumber,
      sourceBranch: mrInfo.sourceBranch,
      commonRules: common,
      languages,
      personality,
      reviewContext,
      contextWindowSize: args.contextWindowSize,
      apiTimeoutMs: args.apiTimeoutMs,
      maxDiffLines: args.maxDiffLines,
      repoDir: args.repoDir,
    },
    diffs
  );

  if (result.rateLimited) {
    await forge.addLabel(repo, args.prNumber, "manual-review-needed");
    await forge.addLabel(repo, args.prNumber, "bot-rate-limited");
    await forge.upsertSummaryComment(
      repo,
      args.prNumber,
      REVIEW_SUMMARY_MARKER,
      "**Automated review could not complete** — Claude API rate limit exceeded. A human review is required."
    );
    const artifact: ReviewArtifact = {
      prNumber: args.prNumber,
      repoSlug: repo.slug,
      timestamp: new Date().toISOString(),
      source: "review-agent",
      reviewStatus: "rate-limited",
      files: result.fileReviews,
      totals: { errors: 0, warnings: 0 },
      gateResult: "pass",
      blocking: [],
      rejected: [],
      commentMap: previousArtifact?.commentMap ?? {},
    };
    writeFileSync(args.artifactPath, JSON.stringify(artifact, null, 2));
    await telemetry?.flush();
    return 0;
  }

  await forge.removeLabel(repo, args.prNumber, "manual-review-needed");
  await forge.removeLabel(repo, args.prNumber, "bot-rate-limited");

  // Enforce per-repo suppressions in code — the prompt-side suppression note is
  // advisory only and must never be the last line of defense.
  const { fileReviews, suppressedCount } = applySuppressions(
    result.fileReviews,
    reviewContext.suppressions
  );

  let errorCount = 0;
  let warningCount = 0;
  for (const fr of fileReviews) {
    for (const f of fr.findings) {
      if (f.severity === "error") errorCount++;
      else warningCount++;
    }
  }
  const blocking = computeBlocking(fileReviews);

  // Stateless dedup: rebuild the previous-run comment map from the MR's own
  // threads (hidden fingerprint markers). Survives artifact expiry — the root
  // cause of duplicate inline comments on every push. A failed scan degrades
  // to the artifact fallback instead of aborting a review that already paid
  // for its Claude calls.
  let threads: Thread[] = [];
  try {
    threads = await forge.getThreads(repo, args.prNumber);
  } catch (err) {
    console.error(
      `Could not scan MR threads for dedup markers: ${
        err instanceof Error ? err.message : "unknown error"
      }. Falling back to the previous artifact's comment map.`
    );
  }
  const previousMap: CommentMap = buildPreviousMapFromThreads(
    threads,
    previousArtifact?.commentMap ?? {}
  );

  const actions = classifyFindings(fileReviews, previousMap, args.prNumber);
  const diffByPath = new Map(diffs.map((d) => [d.newPath, d.diff]));
  const newComments = new Map<string, { threadId: string; noteId: string }>();
  const inlinePostFailures: Array<{ path: string; line: number; error: string }> = [];

  // Cap inline volume: highest-priority findings post first, the rest are
  // listed in the summary instead of flooding the MR.
  const newActionItems = actions
    .filter(
      (a): a is ReconciliationAction & { finding: NonNullable<ReconciliationAction["finding"]>; path: string } =>
        a.type === "new" && a.finding !== undefined && a.path !== undefined
    )
    .map((a) => ({ action: a, finding: a.finding }));
  const { toPost, overflow } = planInlineComments(newActionItems, args.maxInlineComments);

  for (const item of toPost) {
    const { action } = item;
    const fileDiff = diffByPath.get(action.path) ?? "";
    const body = `${action.finding.message}\n\n${findingMarker(action.fingerprint, action.path)}`;
    try {
      const commentResult = await forge.createInlineComment(
        repo,
        args.prNumber,
        { path: action.path, newLine: action.finding.line, diff: fileDiff },
        body
      );
      if (commentResult) {
        newComments.set(action.fingerprint, commentResult);
      } else {
        inlinePostFailures.push({
          path: action.path,
          line: action.finding.line,
          error: "finding line is not part of the diff",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error(
        `Inline comment failed at ${action.path}:${action.finding.line} — ${message}. Listing in summary instead.`
      );
      inlinePostFailures.push({ path: action.path, line: action.finding.line, error: message });
    }
  }

  // A previous finding's absence only means "fixed" if its file was actually
  // reviewed this run. Threads on files whose review failed (fetch error, too
  // large, API error) must not be auto-resolved by that failure; entries that
  // predate path tracking are skipped whenever any file failed.
  const erroredPaths = new Set(result.errors.map((e) => e.filePath));
  for (const action of actions) {
    if (action.type === "fixed" && action.previousEntry) {
      const entryPath = action.previousEntry.path;
      if (entryPath ? erroredPaths.has(entryPath) : erroredPaths.size > 0) {
        continue;
      }
      try {
        await forge.resolveThread(repo, args.prNumber, action.previousEntry.threadId, true);
        await forge.addReply(
          repo,
          args.prNumber,
          action.previousEntry.threadId,
          action.previousEntry.noteId,
          "This issue no longer appears in the latest revision. Marking resolved."
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        console.error(`Could not resolve stale thread ${action.previousEntry.threadId}: ${message}`);
      }
    }
  }

  const summaryParts = [
    `**Code Review Summary:** ${errorCount} error(s), ${warningCount} warning(s).`,
  ];
  if (blocking.length > 0) {
    summaryParts.push(
      `\n**${blocking.length} verified blocking finding(s)** (these fail the gate in \`block\` mode):`
    );
    for (const b of blocking) {
      summaryParts.push(`- \`${b.path}:${b.line}\` ${b.ruleId}: ${b.message}`);
    }
  }
  if (result.rejected.length > 0) {
    summaryParts.push(
      `\n${result.rejected.length} candidate finding(s) were rejected by the verification pass and not posted.`
    );
  }
  if (suppressedCount > 0) {
    summaryParts.push(
      `\n${suppressedCount} finding(s) suppressed by \`review-context.json\`.`
    );
  }
  if (overflow.length > 0) {
    summaryParts.push(
      `\n**${overflow.length} lower-priority finding(s) not posted inline** (inline cap ${args.maxInlineComments}):`
    );
    for (const item of overflow) {
      summaryParts.push(
        `- \`${item.action.path}:${item.finding.line}\` ${item.finding.ruleId}: ${item.finding.message}`
      );
    }
  }
  if (result.errors.length > 0) {
    summaryParts.push("\n**Skipped files:**");
    for (const err of result.errors) {
      summaryParts.push(`- \`${err.filePath}\`: ${err.error}`);
    }
  }
  if (inlinePostFailures.length > 0) {
    summaryParts.push(
      `\n**${inlinePostFailures.length} finding(s) could not be posted inline:**`
    );
    for (const f of inlinePostFailures) {
      summaryParts.push(`- \`${f.path}:${f.line}\` — ${f.error}`);
    }
  }
  await forge.upsertSummaryComment(
    repo,
    args.prNumber,
    REVIEW_SUMMARY_MARKER,
    summaryParts.join("\n")
  );

  const updatedCommentMap = buildUpdatedCommentMap(actions, newComments);

  const gateResult = blocking.length > 0 ? "fail" : "pass";
  const artifact: ReviewArtifact = {
    prNumber: args.prNumber,
    repoSlug: repo.slug,
    timestamp: new Date().toISOString(),
    source: "review-agent",
    reviewStatus: "completed",
    files: fileReviews,
    totals: { errors: errorCount, warnings: warningCount },
    gateResult,
    blocking,
    rejected: result.rejected,
    commentMap: updatedCommentMap,
  };
  writeFileSync(args.artifactPath, JSON.stringify(artifact, null, 2));

  console.log(
    `Review complete: ${errorCount} errors, ${warningCount} warnings, ` +
      `${blocking.length} blocking, ${result.rejected.length} rejected by verification, gate: ${gateResult}`
  );
  await telemetry?.flush();
  // The review CLI reports; the gate job decides. Findings never fail this job.
  return 0;
}
