import {
  ClaudeClient,
  RateLimitError,
  type RuleMap,
  type LanguageRules,
  type Personality,
  type ReviewContext,
  type FileReview,
  getRulesForFile,
} from "@gitagents/core";
import {
  type Forge,
  type RepoRef,
  type FileDiff,
} from "@gitagents/forge";
import { shouldSkipFile, hasXcoreChanges } from "./filter.js";
import { parseHunks, buildHybridContext, getChangedLines } from "./diff-parser.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt-builder.js";
import { reviewFile } from "./reviewer.js";
import { detectMissingFileReferences } from "./missing-files.js";
import { selectRelevantRules } from "./rule-selector.js";
import { detectProjectProfileFromRepository } from "./project-profile.js";
import { detectCppHeaderImpact } from "./cpp-impact.js";
import { mapWithConcurrency } from "./concurrency.js";
import { applyGatePolicy, isMechanicallyVerified } from "./severity-policy.js";
import { verifyFileFindings } from "./verifier.js";
import { REPO_TOOLS, createRepoToolExecutor } from "./repo-tools.js";
import type { OrchestratorResult } from "./types.js";

/**
 * At most this many per-file Claude chains (review + verify) run at once.
 * Unbounded parallelism drives the API into 429s, and a rate-limited file's
 * findings are silently lost.
 */
const CLAUDE_CONCURRENCY = 4;

/**
 * Tool round-trips the verifier may spend per file. Tools are free (they read
 * the CI checkout) but each round is another Claude call, so the budget caps
 * per-file cost. Three rounds is enough to read a definition and check a caller.
 */
const MAX_VERIFY_TOOL_ROUNDS = 3;

export interface OrchestratorConfig {
  forge: Forge;
  claudeClient: ClaudeClient;
  repo: RepoRef;
  mrIid: number;
  sourceBranch: string;
  commonRules: RuleMap;
  languages: LanguageRules[];
  personality: Personality;
  reviewContext: ReviewContext;
  contextWindowSize: number;
  apiTimeoutMs: number;
  maxDiffLines: number;
  /** Consumer checkout, used to serve the verifier's read-only evidence tools. */
  repoDir: string;
}

export async function orchestrateReview(
  config: OrchestratorConfig,
  diffs: FileDiff[]
): Promise<OrchestratorResult> {
  const xcoreChanged = hasXcoreChanges(diffs);
  const fileReviews: FileReview[] = [];
  const errors: Array<{ filePath: string; error: string }> = [];
  let rateLimited = false;

  // Filter files
  const reviewableDiffs = diffs.filter(
    (d) => !shouldSkipFile(d.newPath, xcoreChanged, d)
  );
  const projectText = reviewableDiffs
    .map((diff) => `${diff.newPath}\n${diff.diff}`)
    .join("\n");
  const projectProfile = await detectProjectProfileFromRepository({
    diffs: reviewableDiffs,
    reader: config.forge,
    repo: config.repo,
    ref: config.sourceBranch,
  });

  // Build review tasks
  const tasks = await Promise.all(
    reviewableDiffs.map(async (diff) => {
      const filePath = diff.newPath;

      // Fetch full file content for context
      let fileContent: string;
      try {
        fileContent = await config.forge.getFileContent(
          config.repo,
          filePath,
          config.sourceBranch
        );
      } catch {
        errors.push({ filePath, error: "Could not fetch file content" });
        return null;
      }

      const fileLines = fileContent.split("\n");

      // Check for generated file header
      if (shouldSkipFile(filePath, xcoreChanged, diff, fileLines.slice(0, 10).join("\n"))) {
        return null;
      }

      // Parse diff and build hybrid context
      const hunks = parseHunks(diff.diff);
      const hybridContext = buildHybridContext(
        fileLines,
        hunks,
        config.contextWindowSize,
        config.maxDiffLines
      );
      const changedLines = getChangedLines(hunks);
      if (changedLines.length === 0) {
        return null;
      }
      const missingFileFindings = await detectMissingFileReferences({
        filePath,
        fileLines,
        changedLines,
        repo: config.repo,
        ref: config.sourceBranch,
        reader: config.forge,
      });
      const preFindings = [
        ...missingFileFindings,
        ...detectCppHeaderImpact({
          filePath,
          fileLines,
          changedLines,
          diffs: reviewableDiffs,
        }),
      ];

      // Skip if file too large
      if (hybridContext.includes("[FILE TOO LARGE")) {
        errors.push({ filePath, error: hybridContext });
        return null;
      }

      // Get merged rules for this file's language. The full merged map is kept
      // for gate-policy lookup: findings may cite any rule the prompt saw, and
      // gate eligibility must come from the rule's own flag, not the model.
      const mergedRules = getRulesForFile(
        filePath,
        config.commonRules,
        config.languages
      );
      const rules = selectRelevantRules(mergedRules, {
        filePath,
        fileContent,
        hybridContext,
        projectText,
        projectProfile,
      });

      const systemPrompt = buildSystemPrompt(
        config.personality,
        rules,
        config.reviewContext,
        filePath,
        projectProfile
      );

      const userPrompt = buildUserPrompt(filePath, hybridContext, changedLines);

      return {
        filePath,
        systemPrompt,
        userPrompt,
        hybridContext,
        fileLines,
        changedLines,
        preFindings,
        policyRules: mergedRules,
      };
    })
  );

  // Filter out nulls
  const validTasks = tasks.filter(
    (t): t is NonNullable<typeof t> => t !== null
  );

  // Read-only evidence tools let the verifier settle claims that need code the
  // prompt does not show, instead of blanket-demoting them. Absent a checkout,
  // verification still runs — just on the prompt alone.
  const executeTool = createRepoToolExecutor(config.repoDir);

  // Run each file's review + verification chain with capped concurrency.
  // Verification of file A overlaps review of file B — no barrier between them.
  const rejected: OrchestratorResult["rejected"] = [];
  const results = await mapWithConcurrency(
    validTasks,
    CLAUDE_CONCURRENCY,
    async (task) => {
      try {
        const result = await reviewFile({
          filePath: task.filePath,
          hybridContext: task.userPrompt,
          systemPrompt: task.systemPrompt,
          changedLines: task.changedLines,
          fileLines: task.fileLines,
          preFindings: task.preFindings,
          claudeClient: config.claudeClient,
          timeoutMs: config.apiTimeoutMs,
        });

        if (result.error) {
          errors.push({ filePath: task.filePath, error: result.error });
        }

        // Gate eligibility is stamped in code before verification so that the
        // verifier's confirm/demote verdicts complete the blocking predicate.
        const policied = applyGatePolicy(result.findings, task.policyRules);
        // Mechanically certain static findings are verified in code and bypass
        // the model verifier — a skeptic must not be able to reject them.
        const mechanical = policied
          .filter(isMechanicallyVerified)
          .map((finding) => ({ ...finding, verified: true }));
        const verification = await verifyFileFindings({
          claudeClient: config.claudeClient,
          filePath: task.filePath,
          fileContext: task.hybridContext,
          findings: policied.filter((finding) => !isMechanicallyVerified(finding)),
          timeoutMs: config.apiTimeoutMs,
          ...(executeTool
            ? {
                tools: REPO_TOOLS,
                executeTool,
                maxToolRounds: MAX_VERIFY_TOOL_ROUNDS,
              }
            : {}),
        });
        rejected.push(...verification.rejected);

        return { ...result, findings: [...mechanical, ...verification.findings] };
      } catch (error: unknown) {
        if (error instanceof RateLimitError) {
          rateLimited = true;
          return null;
        }
        const msg =
          error instanceof Error ? error.message : "Unknown error";
        errors.push({ filePath: task.filePath, error: msg });
        return null;
      }
    }
  );

  for (const result of results) {
    if (result && result.findings.length > 0) {
      const ext = result.filePath.split(".").pop() ?? "";
      const lang =
        config.languages.find((l) =>
          l.extensions.includes(`.${ext}`)
        )?.language ?? "unknown";

      fileReviews.push({
        path: result.filePath,
        language: lang,
        findings: result.findings,
      });
    }
  }

  return { fileReviews, errors, rateLimited, rejected };
}
