import { RateLimitError, type LlmClient, type Finding } from "@gitagents/core";
import { buildFixSystemPrompt, buildFixUserPrompt } from "./prompt-builder.js";
import { applyUnifiedDiff } from "./patch.js";
import { validateFix } from "./validator.js";
import { tryDeterministicFix } from "./deterministic-fixes.js";
import type { FixResult } from "./types.js";

export async function fixFinding(
  claudeClient: LlmClient,
  filePath: string,
  fileContent: string,
  finding: Finding,
  timeoutMs: number
): Promise<FixResult> {
  const deterministicResult = tryDeterministicFix(filePath, fileContent, finding);
  if (deterministicResult?.applied) {
    return deterministicResult;
  }

  try {
    const response = await claudeClient.fix({
      systemPrompt: buildFixSystemPrompt(filePath, finding),
      userPrompt: buildFixUserPrompt(filePath, fileContent, finding),
      fileContent,
      finding,
      maxTokens: 4096,
      timeoutMs,
      telemetry: {
        agent: "fix-agent",
        action: "fix-finding",
        target: `${filePath}:${finding.line}`,
        metadata: {
          filePath,
          line: finding.line,
          ruleId: finding.ruleId,
          maxTokens: 4096,
        },
      },
    });

    const patchResult = applyUnifiedDiff(fileContent, response.patch, filePath);
    if (!patchResult.valid || !patchResult.content) {
      return {
        finding,
        filePath,
        fixedContent: fileContent,
        applied: false,
        skipReason: patchResult.reason,
      };
    }

    const fixedContent = patchResult.content;
    const validation = validateFix(fileContent, fixedContent, finding.line);

    if (!validation.valid) {
      return {
        finding,
        filePath,
        fixedContent: fileContent,
        applied: false,
        skipReason: validation.reason,
      };
    }

    return {
      finding,
      filePath,
      fixedContent,
      applied: true,
    };
  } catch (error: unknown) {
    // Rate limits abort the whole fix loop — retrying finding-by-finding
    // against a saturated API just burns the remaining budget.
    if (error instanceof RateLimitError) throw error;
    const message =
      error instanceof Error ? error.message : "Unknown fix error";
    return {
      finding,
      filePath,
      fixedContent: fileContent,
      applied: false,
      skipReason: message,
    };
  }
}
