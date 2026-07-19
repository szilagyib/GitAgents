import type {
  LlmClient,
  LlmSystemPrompt,
  LlmToolSpec,
  LlmToolExecutor,
  Finding,
  RejectedFinding,
} from "@gitagents/core";

export interface VerifyFileFindingsInput {
  claudeClient: LlmClient;
  filePath: string;
  /** The hybrid diff+context already built for the review pass, reused as evidence. */
  fileContext: string;
  findings: Finding[];
  timeoutMs: number;
  /** Read-only evidence tools; omitted, the verifier judges on the prompt alone. */
  tools?: LlmToolSpec[];
  executeTool?: LlmToolExecutor;
  maxToolRounds?: number;
}

export interface VerifyFileFindingsResult {
  findings: Finding[];
  rejected: RejectedFinding[];
  verificationRan: boolean;
}

const VERIFIER_SYSTEM_PROMPT: LlmSystemPrompt = [
  {
    text: `You are a skeptical senior engineer. Your ONLY job is to REFUTE proposed code-review findings.

The code is the source of truth. A finding survives only if its failure scenario is demonstrable from the code. If you cannot demonstrate the failure, you must not confirm it.

You have read-only tools (read_file, search_repo) over the repository under review. Use them when a verdict depends on code the prompt does not show — the definition of a called function, whether a caller already guards the value, whether a symbol exists. Gathering that evidence is cheap; guessing is not. Rule as follows:
- If a tool can settle the claim, use it and then confirm or reject on what you found.
- Only demote when the claim depends on context that is genuinely unavailable (runtime data, external systems, product intent).

For each finding, decide one verdict:
- "confirm": the failure scenario is demonstrable from the code you have seen — you would stake a merge-block on it.
- "demote": plausible, but not provable even after gathering evidence.
- "reject": the finding is wrong — it does not apply, fires on a comment/string literal, misreads the receiver type, or flags a framework idiom that is not a defect.

When you are done gathering evidence, respond with STRICT JSON only. No prose before or after it. Use exactly this schema, with EXACTLY one verdict object per finding index provided:

{"verdicts":[{"index":<n>,"verdict":"confirm"|"demote"|"reject","reason":"<one sentence>"}]}`,
    cacheable: true,
  },
];

function buildVerifierUserPrompt(
  filePath: string,
  fileContext: string,
  findings: Finding[]
): string {
  const numbered = findings
    .map((finding, index) =>
      [
        `[${index}] ruleId=${finding.ruleId} line=${finding.line} severity=${finding.severity} confidence=${finding.confidence}`,
        `    message: ${finding.message}`,
        `    codeContext: ${finding.codeContext}`,
      ].join("\n")
    )
    .join("\n\n");

  return `## File: ${filePath}

The code under review (lines marked with + are new/changed):

<file-under-review path="${filePath}">
${fileContext}
</file-under-review>

## Proposed findings to refute

${numbered}`;
}

/**
 * Adversarial second pass: batch-verify a file's candidate findings against the
 * visible code. Confirmed findings are marked verified; demoted findings drop to
 * medium confidence; rejected findings are removed (and reported in `rejected`).
 *
 * Fail-open by design: any error (rate limit, truncation, non-JSON) returns the
 * findings unchanged with verificationRan=false. Verification must never break a
 * review.
 */
export async function verifyFileFindings(
  input: VerifyFileFindingsInput
): Promise<VerifyFileFindingsResult> {
  if (input.findings.length === 0) {
    return { findings: input.findings, rejected: [], verificationRan: false };
  }

  try {
    const response = await input.claudeClient.verifyFindings({
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      userPrompt: buildVerifierUserPrompt(
        input.filePath,
        input.fileContext,
        input.findings
      ),
      maxTokens: 4096,
      timeoutMs: input.timeoutMs,
      ...(input.tools && input.executeTool
        ? {
            tools: input.tools,
            executeTool: input.executeTool,
            maxToolRounds: input.maxToolRounds,
          }
        : {}),
      telemetry: {
        agent: "review-agent",
        action: "verify-file",
        target: input.filePath,
        metadata: { findingCount: input.findings.length },
      },
    });

    const verdictByIndex = new Map<number, (typeof response.verdicts)[number]>();
    for (const verdict of response.verdicts) {
      if (!verdictByIndex.has(verdict.index)) verdictByIndex.set(verdict.index, verdict);
    }

    const findings: Finding[] = [];
    const rejected: RejectedFinding[] = [];

    input.findings.forEach((finding, index) => {
      const verdict = verdictByIndex.get(index);
      // A missing verdict is treated conservatively as a demotion.
      const kind = verdict?.verdict ?? "demote";

      if (kind === "confirm") {
        findings.push({ ...finding, verified: true });
      } else if (kind === "reject") {
        rejected.push({
          path: input.filePath,
          line: finding.line,
          ruleId: finding.ruleId,
          message: finding.message,
          reason: verdict?.reason || "Rejected by verification pass.",
        });
      } else {
        findings.push({ ...finding, confidence: "medium", verified: false });
      }
    });

    return { findings, rejected, verificationRan: true };
  } catch (error: unknown) {
    console.error(
      `Finding verification failed for ${input.filePath}; keeping findings unverified. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { findings: input.findings, rejected: [], verificationRan: false };
  }
}
