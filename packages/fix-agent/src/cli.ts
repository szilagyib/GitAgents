import {
  computeFingerprint,
  createLlmClient,
  DashboardTelemetryRecorder,
  isReviewArtifact,
  isFixResultArtifact,
  RateLimitError,
  type ReviewArtifact,
  type FixResultArtifact,
  type Finding,
} from "@gitagents/core";
import {
  createForge,
  type Forge,
  type RepoRef,
} from "@gitagents/forge";
import { fixFinding } from "./fixer.js";
import { gitAddFiles, gitCommit, gitPush } from "./git-ops.js";
import { resolveRepoDir, resolveRepoFilePath } from "./paths.js";
import { computeChangedRange } from "./validator.js";
import {
  buildFixSummary,
  buildSuggestSummary,
  shouldAddManualLabel,
  FIX_SUMMARY_MARKER,
  type FindingRef,
  type SkippedRef,
  type MarkedRef,
  type FallbackRef,
} from "./summary.js";
import { suggestionMarker, SUGGESTION_MARKER_RE } from "./markers.js";

export { suggestionMarker } from "./markers.js";
import { resolveFixedThreads } from "./threads.js";
import { readFileSync, writeFileSync, existsSync } from "fs";

export type FixMode = "suggest" | "push" | "off";

interface CliArgs {
  prNumber: number;
  projectId: number;
  forge: string;
  fixMode: FixMode;
  reviewArtifactPath: string;
  fixArtifactPath: string;
  apiBaseUrl: string;
  token: string;
  apiTimeoutMs: number;
  telemetryEnabled: boolean;
  dashboardUrl: string;
  repoDir: string;
  pushUrl: string;
}

export function resolveFixMode(raw: string): FixMode {
  if (raw === "suggest" || raw === "push" || raw === "off") return raw;
  if (raw !== "") {
    console.error(
      `Unknown GITAGENTS_FIX_MODE "${raw}" — falling back to "suggest".`
    );
  }
  return "suggest";
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
    fixMode: resolveFixMode(
      getArg("fix-mode", process.env.GITAGENTS_FIX_MODE ?? "")
    ),
    reviewArtifactPath: getArg("review-artifact", getArg("artifact", "review-result.json")),
    fixArtifactPath: getArg("fix-artifact", "fix-result.json"),
    apiBaseUrl,
    token,
    apiTimeoutMs: parseInt(
      process.env.REVIEW_API_TIMEOUT || getArg("api-timeout", "60000"),
      10
    ),
    telemetryEnabled:
      process.env.GITAGENTS_TELEMETRY !== "0" &&
      getArg("telemetry", "") !== "off",
    dashboardUrl:
      process.env.GITAGENTS_DASHBOARD_URL ||
      getArg("dashboard-url", ""),
    repoDir: resolveRepoDir(
      getArg("repo-dir", ""),
      process.env.CI_PROJECT_DIR,
      process.cwd()
    ),
    pushUrl: resolvePushUrl(getArg("push-url", ""), isGithub),
  };
}

function resolvePushUrl(flagValue: string, isGithub: boolean): string {
  if (flagValue) return flagValue;
  if (isGithub) {
    const server = process.env.GITHUB_SERVER_URL || "https://github.com";
    const repo = process.env.GITHUB_REPOSITORY; // owner/repo
    if (repo) return `${server}/${repo}.git`;
    return "";
  }
  const host = process.env.CI_SERVER_HOST;
  const projectPath = process.env.CI_PROJECT_PATH;
  if (host && projectPath) return `https://${host}/${projectPath}.git`;
  return "";
}

const MAX_FIX_ATTEMPTS = 3;

async function setManualLabel(
  forge: Forge,
  repo: RepoRef,
  prNumber: number,
  needed: boolean
): Promise<void> {
  if (needed) {
    await forge.addLabel(repo, prNumber, "manual-fix-needed");
  } else {
    await forge.removeLabel(repo, prNumber, "manual-fix-needed");
  }
}

function readPreviousFixAttemptCount(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (isFixResultArtifact(raw)) return raw.fixAttemptCount;
  } catch {
    // fall through
  }
  return 0;
}

function writeFixResult(path: string, artifact: FixResultArtifact): void {
  writeFileSync(path, JSON.stringify(artifact, null, 2));
}

function emptyFixResult(
  args: CliArgs,
  repoSlug: string,
  fixAttemptCount: number
): FixResultArtifact {
  return {
    prNumber: args.prNumber,
    repoSlug,
    timestamp: new Date().toISOString(),
    source: "fix-agent",
    fixAttemptCount,
    fixesApplied: false,
    appliedFixCount: 0,
    applied: [],
    skipped: [],
    manual: [],
  };
}

function collectFindings(review: ReviewArtifact): {
  fixable: Array<{ filePath: string; finding: Finding }>;
  manual: FindingRef[];
} {
  const fixable: Array<{ filePath: string; finding: Finding }> = [];
  const manual: FindingRef[] = [];
  for (const file of review.files) {
    for (const finding of file.findings) {
      if (isFixCandidate(finding)) {
        fixable.push({ filePath: file.path, finding });
      } else if (isManualActionNeeded(finding)) {
        manual.push({
          path: file.path,
          line: finding.line,
          ruleId: finding.ruleId,
          message: finding.message,
        });
      }
    }
  }
  return { fixable, manual };
}

function buildTelemetry(args: CliArgs, repoSlug: string, forgeKind: string) {
  return args.telemetryEnabled && args.dashboardUrl
    ? new DashboardTelemetryRecorder({
        dashboardUrl: args.dashboardUrl,
        token: process.env.GITAGENTS_DASHBOARD_TOKEN,
        runId: `fix-${repoSlug.replace(/\W+/g, "-")}-${args.prNumber}-${Date.now()}`,
        metadata: {
          repoSlug,
          prNumber: args.prNumber,
          forge: forgeKind,
          agent: "fix-agent",
        },
      })
    : undefined;
}

export async function runFix(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (!args.prNumber) {
    console.error("Usage: git-agents fix --pr <number> --review-artifact <path> --fix-artifact <path> [--fix-mode suggest|push|off]");
    return 1;
  }

  let review: ReviewArtifact;
  try {
    const raw = JSON.parse(readFileSync(args.reviewArtifactPath, "utf-8"));
    if (!isReviewArtifact(raw)) {
      console.error("Invalid review artifact");
      return 1;
    }
    review = raw;
  } catch {
    console.log("No review artifact found - nothing to fix.");
    return 0;
  }

  const { forge, repo } = createForge({
    override: args.forge,
    env: process.env,
    token: args.token,
    apiBaseUrl: args.apiBaseUrl,
    projectId: args.projectId,
  });

  if (args.fixMode === "off") {
    console.log("Fix agent disabled (GITAGENTS_FIX_MODE=off).");
    writeFixResult(args.fixArtifactPath, emptyFixResult(args, repo.slug, 0));
    return 0;
  }

  if (args.fixMode === "suggest") {
    return runSuggestMode(args, review, forge, repo);
  }
  return runPushMode(args, review, forge, repo);
}

/**
 * Default mode: post each safe fix as a native one-click suggestion comment.
 * Nothing is committed or pushed — no retrigger loops, no races, no bot
 * commits, and the PAT needs no repository write access.
 */
async function runSuggestMode(
  args: CliArgs,
  review: ReviewArtifact,
  forge: Forge,
  repo: RepoRef
): Promise<number> {
  const { fixable, manual } = collectFindings(review);

  if (fixable.length === 0) {
    writeFixResult(args.fixArtifactPath, {
      ...emptyFixResult(args, repo.slug, 0),
      manual,
    });
    // Manual findings still need the human escalation channel even when there
    // is nothing to suggest: list them in the summary and label the MR.
    const summary = buildSuggestSummary({
      posted: [],
      alreadySuggested: [],
      fallbacks: [],
      skipped: [],
      manual,
    });
    if (summary) {
      await forge.upsertSummaryComment(repo, args.prNumber, FIX_SUMMARY_MARKER, summary);
    }
    await setManualLabel(forge, repo, args.prNumber, manual.length > 0);
    console.log(
      manual.length > 0
        ? `No auto-fixable findings - ${manual.length} need manual attention.`
        : "No auto-fixable findings - nothing to suggest."
    );
    return 0;
  }

  const telemetry = buildTelemetry(args, repo.slug, repo.forge);
  const claude = createLlmClient(process.env, {
    telemetry,
    runId: telemetry?.runId,
  });
  const mrInfo = await forge.getPullRequest(repo, args.prNumber);
  const diffs = await forge.getDiffs(repo, args.prNumber);
  const diffByPath = new Map(diffs.map((d) => [d.newPath, d.diff]));

  // Stateless dedup: a suggestion posted on an earlier run carries a hidden
  // fingerprint marker; never post the same suggestion twice.
  const alreadySuggestedFps = new Set<string>();
  try {
    const threads = await forge.getThreads(repo, args.prNumber);
    for (const thread of threads) {
      for (const note of thread.notes) {
        for (const match of note.body.matchAll(SUGGESTION_MARKER_RE)) {
          alreadySuggestedFps.add(match[1]);
        }
      }
    }
    // Fallback suggestions never get an inline thread; their markers persist
    // in the fix summary instead, so scan that too.
    const summaryBody = await forge.getSummaryComment(
      repo,
      args.prNumber,
      FIX_SUMMARY_MARKER
    );
    for (const match of summaryBody?.matchAll(SUGGESTION_MARKER_RE) ?? []) {
      alreadySuggestedFps.add(match[1]);
    }
  } catch (err) {
    console.error(
      `Could not scan existing threads for suggestion markers: ${
        err instanceof Error ? err.message : "unknown error"
      }. Proceeding without dedup.`
    );
  }

  const posted: FindingRef[] = [];
  const alreadySuggested: MarkedRef[] = [];
  const fallbacks: FallbackRef[] = [];
  const skipped: SkippedRef[] = [];
  let rateLimited = false;
  // Every fix is computed against PRISTINE branch content — chaining fixes
  // onto fixed content desyncs finding line numbers (they index the original).
  const pristineByPath = new Map<string, string>();

  for (let i = 0; i < fixable.length; i++) {
    const { filePath, finding } = fixable[i];
    const ref: FindingRef = {
      path: filePath,
      line: finding.line,
      ruleId: finding.ruleId,
      message: finding.message,
    };
    const fp = computeFingerprint(args.prNumber, finding.ruleId, filePath, finding.codeContext);
    if (alreadySuggestedFps.has(fp)) {
      alreadySuggested.push({ ...ref, fingerprint: fp });
      continue;
    }

    let pristine = pristineByPath.get(filePath);
    if (pristine === undefined) {
      try {
        pristine = await forge.getFileContent(repo, filePath, mrInfo.sourceBranch);
        pristineByPath.set(filePath, pristine);
      } catch {
        skipped.push({ ...ref, reason: "could not fetch file" });
        continue;
      }
    }

    let result;
    try {
      result = await fixFinding(claude, filePath, pristine, finding, args.apiTimeoutMs);
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Stop the loop — every remaining finding would hit the same wall.
        for (const rest of fixable.slice(i)) {
          skipped.push({
            path: rest.filePath,
            line: rest.finding.line,
            ruleId: rest.finding.ruleId,
            message: rest.finding.message,
            reason: "Claude API rate limit exceeded",
          });
        }
        rateLimited = true;
        break;
      }
      throw err;
    }
    if (!result.applied) {
      skipped.push({ ...ref, reason: result.skipReason ?? "unknown" });
      continue;
    }

    const range = computeChangedRange(pristine, result.fixedContent);
    if (!range) {
      skipped.push({ ...ref, reason: "fix produced no line changes" });
      continue;
    }

    const explanation =
      `**Proposed fix** for \`${finding.ruleId}\` at \`${filePath}:${finding.line}\`: ${finding.message}` +
      `\n\n${suggestionMarker(fp)}`;
    try {
      const comment = await forge.createSuggestionComment(
        repo,
        args.prNumber,
        {
          path: filePath,
          startLine: range.startLine,
          endLine: range.endLine,
          diff: diffByPath.get(filePath) ?? "",
        },
        explanation,
        range.replacementLines
      );
      if (comment) {
        posted.push(ref);
      } else {
        fallbacks.push({ ...ref, fingerprint: fp, replacementLines: range.replacementLines });
      }
    } catch (err) {
      skipped.push({
        ...ref,
        reason: `suggestion comment failed: ${err instanceof Error ? err.message : "unknown error"}`,
      });
    }
  }

  // The artifact records COMMITTED fixes only; suggest mode commits nothing,
  // so fixesApplied stays false and the gate evaluates findings directly.
  writeFixResult(args.fixArtifactPath, {
    ...emptyFixResult(args, repo.slug, 0),
    skipped,
    manual,
  });

  const summary = buildSuggestSummary({ posted, alreadySuggested, fallbacks, skipped, manual });
  if (summary) {
    await forge.upsertSummaryComment(repo, args.prNumber, FIX_SUMMARY_MARKER, summary);
  }
  await setManualLabel(
    forge,
    repo,
    args.prNumber,
    shouldAddManualLabel({ skipped, manual }) || fallbacks.length > 0
  );

  console.log(
    `Suggest mode: ${posted.length} suggestion(s) posted, ${alreadySuggested.length} already present, ` +
      `${fallbacks.length} fallback(s), ${skipped.length} skipped.` +
      (rateLimited ? " Stopped early: Claude API rate limit exceeded." : "")
  );
  await telemetry?.flush();
  return 0;
}

/** Opt-in legacy mode: commit and push fixes to the source branch. */
async function runPushMode(
  args: CliArgs,
  review: ReviewArtifact,
  forge: Forge,
  repo: RepoRef
): Promise<number> {
  const previousFixAttemptCount = readPreviousFixAttemptCount(args.fixArtifactPath);

  if (previousFixAttemptCount >= MAX_FIX_ATTEMPTS) {
    await forge.addLabel(repo, args.prNumber, "manual-fix-needed");
    await forge.upsertSummaryComment(
      repo,
      args.prNumber,
      FIX_SUMMARY_MARKER,
      `**Auto-fix gave up** after ${MAX_FIX_ATTEMPTS} attempts. The following issues need manual attention:\n` +
        review.files
          .flatMap((f) =>
            f.findings
              .filter(isFixCandidate)
              .map((finding) => `- \`${f.path}:${finding.line}\` - ${finding.ruleId}: ${finding.message}`)
          )
          .join("\n")
    );
    writeFixResult(args.fixArtifactPath, emptyFixResult(args, repo.slug, previousFixAttemptCount));
    return 0;
  }

  const { fixable: fixableFindings, manual: manualFindings } = collectFindings(review);

  if (fixableFindings.length === 0 && manualFindings.length === 0) {
    await forge.removeLabel(repo, args.prNumber, "manual-fix-needed");
    writeFixResult(args.fixArtifactPath, emptyFixResult(args, repo.slug, previousFixAttemptCount));
    console.log("No findings to act on - cleared manual-fix-needed if present.");
    return 0;
  }

  if (fixableFindings.length === 0) {
    await forge.addLabel(repo, args.prNumber, "manual-fix-needed");
    await forge.upsertSummaryComment(
      repo,
      args.prNumber,
      FIX_SUMMARY_MARKER,
      buildFixSummary({ applied: [], skipped: [], manual: manualFindings })
    );
    writeFixResult(args.fixArtifactPath, {
      ...emptyFixResult(args, repo.slug, previousFixAttemptCount + 1),
      manual: manualFindings,
    });
    console.log("No auto-fixable findings - labeled manual-fix-needed.");
    return 0;
  }

  const telemetry = buildTelemetry(args, repo.slug, repo.forge);
  const claude = createLlmClient(process.env, {
    telemetry,
    runId: telemetry?.runId,
  });
  const mrInfo = await forge.getPullRequest(repo, args.prNumber);

  // Fixes chain onto already-fixed content, but finding line numbers index the
  // pristine file. Applying bottom-up within each file keeps every line above
  // the current finding untouched, so those numbers (and the over-edit window
  // anchored to them) stay valid.
  fixableFindings.sort((a, b) =>
    a.filePath === b.filePath
      ? b.finding.line - a.finding.line
      : a.filePath.localeCompare(b.filePath)
  );

  const applied: FindingRef[] = [];
  const appliedRefs: Array<{ ref: FindingRef; fingerprint: string }> = [];
  const skipped: SkippedRef[] = [];
  const commitLines: string[] = [];
  const fixedFiles = new Map<string, string>();
  let pushError: string | undefined;

  for (let i = 0; i < fixableFindings.length; i++) {
    const { filePath, finding } = fixableFindings[i];
    let fileContent: string;
    if (fixedFiles.has(filePath)) {
      fileContent = fixedFiles.get(filePath)!;
    } else {
      try {
        fileContent = await forge.getFileContent(repo, filePath, mrInfo.sourceBranch);
      } catch {
        skipped.push({
          path: filePath,
          line: finding.line,
          ruleId: finding.ruleId,
          message: finding.message,
          reason: "could not fetch file",
        });
        continue;
      }
    }

    let result;
    try {
      result = await fixFinding(claude, filePath, fileContent, finding, args.apiTimeoutMs);
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Stop the loop — every remaining finding would hit the same wall.
        for (const rest of fixableFindings.slice(i)) {
          skipped.push({
            path: rest.filePath,
            line: rest.finding.line,
            ruleId: rest.finding.ruleId,
            message: rest.finding.message,
            reason: "Claude API rate limit exceeded",
          });
        }
        break;
      }
      throw err;
    }

    if (result.applied) {
      fixedFiles.set(filePath, result.fixedContent);
      const ref: FindingRef = {
        path: filePath,
        line: finding.line,
        ruleId: finding.ruleId,
        message: finding.message,
      };
      applied.push(ref);
      appliedRefs.push({
        ref,
        fingerprint: computeFingerprint(args.prNumber, finding.ruleId, filePath, finding.codeContext),
      });
      commitLines.push(`fix: [${finding.ruleId}] ${filePath}:${finding.line}\n- ${finding.message}`);
    } else {
      skipped.push({
        path: filePath,
        line: finding.line,
        ruleId: finding.ruleId,
        message: finding.message,
        reason: result.skipReason ?? "unknown",
      });
    }
  }

  if (applied.length > 0) {
    for (const [filePath, content] of fixedFiles) {
      writeFileSync(resolveRepoFilePath(args.repoDir, filePath), content);
    }

    if (!args.pushUrl || !args.token) {
      pushError = "Missing push URL or token. Set CI_SERVER_HOST + CI_PROJECT_PATH (GitLab) or GITHUB_REPOSITORY (GitHub), or pass --push-url, and set GITLAB_TOKEN/GH_TOKEN.";
    } else {
      try {
        gitAddFiles(args.repoDir, [...fixedFiles.keys()]);
        gitCommit(args.repoDir, commitLines.join("\n\n"));
        gitPush(args.repoDir, args.pushUrl, mrInfo.sourceBranch, args.token);
        console.log(`Applied ${applied.length} fixes, pushed to ${mrInfo.sourceBranch}.`);
      } catch (error) {
        pushError = error instanceof Error ? error.message : "Unknown git push error";
        console.error(`Auto-fix produced a patch but could not push it: ${pushError}`);
      }
    }

    if (!pushError) {
      const threadResult = await resolveFixedThreads(
        forge,
        repo,
        args.prNumber,
        appliedRefs,
        review.commentMap
      );
      if (threadResult.resolvedCount > 0) {
        console.log(`Resolved ${threadResult.resolvedCount} discussion thread(s).`);
      }
      for (const failure of threadResult.failed) {
        console.error(
          `Could not resolve thread for ${failure.ref.path}:${failure.ref.line} - ${failure.error}`
        );
      }
    }
  } else {
    console.log("No fixes applied.");
  }

  const fixesPushed = applied.length > 0 && !pushError;
  writeFixResult(args.fixArtifactPath, {
    prNumber: args.prNumber,
    repoSlug: repo.slug,
    timestamp: new Date().toISOString(),
    source: "fix-agent",
    fixAttemptCount: previousFixAttemptCount + 1,
    fixesApplied: fixesPushed,
    appliedFixCount: fixesPushed ? applied.length : 0,
    applied,
    skipped,
    manual: manualFindings,
  });

  const summary = buildFixSummary({ applied, skipped, manual: manualFindings, pushError });
  if (summary) {
    await forge.upsertSummaryComment(repo, args.prNumber, FIX_SUMMARY_MARKER, summary);
  }
  if (shouldAddManualLabel({ skipped, manual: manualFindings, pushError })) {
    await forge.addLabel(repo, args.prNumber, "manual-fix-needed");
  } else {
    await forge.removeLabel(repo, args.prNumber, "manual-fix-needed");
  }

  await telemetry?.flush();
  return 0;
}

export function isFixCandidate(finding: Finding): boolean {
  return finding.autoFixable;
}

export function isManualActionNeeded(finding: Finding): boolean {
  return finding.severity === "error" && finding.confidence === "high";
}
