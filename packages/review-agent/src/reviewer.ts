import type {
  ClaudeClient,
  ClaudeSystemPrompt,
  Finding,
  ClaudeReviewResponse,
} from "@gitagents/core";
import { runStaticChecks } from "./static-checks.js";
import { normalizeFixability } from "./fixability.js";

export interface ReviewFileInput {
  filePath: string;
  hybridContext: string;
  systemPrompt: ClaudeSystemPrompt;
  changedLines: number[];
  fileLines: string[];
  preFindings?: Finding[];
  claudeClient: ClaudeClient;
  timeoutMs: number;
}

export interface ReviewFileResult {
  filePath: string;
  findings: Finding[];
  summary: string;
  error?: string;
}

export async function reviewFile(
  input: ReviewFileInput
): Promise<ReviewFileResult> {
  const staticFindings = runStaticChecks(
    input.filePath,
    input.fileLines,
    input.changedLines
  );
  const preFindings = input.preFindings ?? [];

  try {
    const response: ClaudeReviewResponse = await input.claudeClient.review({
      systemPrompt: input.systemPrompt,
      userPrompt: input.hybridContext,
      maxTokens: 4096,
      timeoutMs: input.timeoutMs,
      telemetry: {
        agent: "review-agent",
        action: "review-file",
        target: input.filePath,
        metadata: {
          maxTokens: 4096,
        },
      },
    });

    const changedLineSet = new Set(input.changedLines);
    const claudeFindings =
      changedLineSet.size > 0
        ? response.findings.filter((finding) => changedLineSet.has(finding.line))
        : response.findings;
    const findings = dedupeFindings([...preFindings, ...staticFindings, ...claudeFindings])
      .map((finding) => normalizeFixability(input.filePath, finding));

    return {
      filePath: input.filePath,
      findings,
      summary: response.summary,
    };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown review error";
    return {
      filePath: input.filePath,
      findings: dedupeFindings([...preFindings, ...staticFindings])
        .map((finding) => normalizeFixability(input.filePath, finding)),
      summary: "",
      error: message,
    };
  }
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const deduped: Finding[] = [];

  for (const finding of findings) {
    const key = `${finding.line}:${finding.ruleId}:${finding.codeContext.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
}
