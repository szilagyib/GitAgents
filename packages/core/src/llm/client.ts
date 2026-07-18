import { normalizeFinding } from "../types.js";
import { withRetry } from "../retry.js";
import {
  buildLlmTelemetryAction,
  type ClaudeActionContext,
  type TelemetrySink,
} from "../telemetry.js";
import type { ModelPricingOverride } from "./pricing.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmSystemBlock,
  LlmToolCall,
  NormalizedUsage,
} from "./provider.js";
import type {
  LlmFixRequest,
  LlmFixResponse,
  LlmReviewRequest,
  LlmReviewResponse,
  LlmSystemPrompt,
  LlmToolExecutor,
  LlmVerifyRequest,
  LlmVerifyResponse,
  LlmVerifyVerdict,
  VerifyVerdictKind,
} from "./types.js";

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

export interface LlmClientOptions {
  model?: string;
  telemetry?: TelemetrySink;
  runId?: string;
  pricingOverride?: ModelPricingOverride;
}

/**
 * Provider-neutral orchestration for review, fix and adversarial verification.
 * All provider specifics (message/tool translation, usage, error classification)
 * live behind the LlmProvider it is given; this class never touches a provider SDK.
 */
export class LlmClient {
  private model: string;
  private telemetry?: TelemetrySink;
  private runId: string;
  private pricingOverride?: ModelPricingOverride;

  constructor(private provider: LlmProvider, opts: LlmClientOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.telemetry = opts.telemetry;
    this.runId = opts.runId ?? "default";
    this.pricingOverride = opts.pricingOverride;
  }

  async review(request: LlmReviewRequest): Promise<LlmReviewResponse> {
    const startedAt = new Date();
    try {
      const response = await withRetry(
        () =>
          this.provider.createMessage({
            model: this.model,
            maxTokens: request.maxTokens,
            system: toBlocks(request.systemPrompt),
            messages: [{ role: "user", content: request.userPrompt }],
            timeoutMs: request.timeoutMs,
          }),
        { shouldRetry: (err) => this.provider.isTransientError(err) },
      );

      if (response.stopReason === "max_tokens") {
        console.error(
          "LLM review response was truncated (max_tokens); findings may be incomplete.",
        );
      }

      const parsed = this.parseReviewResponse(response.text);
      this.recordTelemetry(
        withResultMetadata(request.telemetry, {
          findingCount: parsed.findings.length,
          summaryLength: parsed.summary.length,
        }),
        startedAt,
        "ok",
        response.usage,
      );
      return parsed;
    } catch (error: unknown) {
      this.recordTelemetry(
        request.telemetry,
        startedAt,
        "error",
        undefined,
        error instanceof Error ? error.message : "Unknown LLM review error",
      );
      throw this.asRateLimit(error);
    }
  }

  async fix(request: LlmFixRequest): Promise<LlmFixResponse> {
    const startedAt = new Date();
    try {
      const response = await withRetry(
        () =>
          this.provider.createMessage({
            model: this.model,
            maxTokens: request.maxTokens,
            system: toBlocks(request.systemPrompt),
            messages: [{ role: "user", content: request.userPrompt }],
            timeoutMs: request.timeoutMs,
          }),
        { shouldRetry: (err) => this.provider.isTransientError(err) },
      );

      this.recordTelemetry(request.telemetry, startedAt, "ok", response.usage);
      return this.parseFixResponse(response.text);
    } catch (error: unknown) {
      this.recordTelemetry(
        request.telemetry,
        startedAt,
        "error",
        undefined,
        error instanceof Error ? error.message : "Unknown LLM fix error",
      );
      throw this.asRateLimit(error);
    }
  }

  /**
   * Adversarial verification, optionally with read-only evidence tools.
   *
   * When `tools` and `executeTool` are supplied the model may request reads/searches
   * before ruling; each round is bounded by `maxToolRounds` so a file's cost stays
   * predictable. Usage across every round is summed into one telemetry action.
   */
  async verifyFindings(request: LlmVerifyRequest): Promise<LlmVerifyResponse> {
    const startedAt = new Date();
    const maxToolRounds =
      request.tools?.length && request.executeTool ? (request.maxToolRounds ?? 0) : 0;
    const messages: LlmMessage[] = [{ role: "user", content: request.userPrompt }];
    const totalUsage: NormalizedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    let toolRounds = 0;

    try {
      for (let round = 0; ; round++) {
        const response = await withRetry(
          () =>
            this.provider.createMessage({
              model: this.model,
              maxTokens: request.maxTokens,
              system: toBlocks(request.systemPrompt),
              messages,
              ...(maxToolRounds > 0 && request.tools ? { tools: request.tools } : {}),
              timeoutMs: request.timeoutMs,
            }),
          { shouldRetry: (err) => this.provider.isTransientError(err) },
        );

        accumulate(totalUsage, response.usage);

        if (response.stopReason === "max_tokens") {
          // Verification is treated as unavailable when truncated; callers fail open.
          throw new Error("LLM verify response truncated (max_tokens)");
        }

        if (
          response.stopReason === "tool_use" &&
          response.toolCalls.length > 0 &&
          request.executeTool
        ) {
          if (round >= maxToolRounds) {
            throw new Error(`LLM verify exceeded its tool-round budget (${maxToolRounds})`);
          }
          toolRounds++;
          const executeTool = request.executeTool;
          const results = await Promise.all(
            response.toolCalls.map(async (call) => ({
              id: call.id,
              content: await this.runTool(executeTool, call),
            })),
          );
          messages.push({
            role: "assistant",
            text: response.text,
            toolCalls: response.toolCalls,
          });
          for (const result of results) {
            messages.push({ role: "tool_result", toolCallId: result.id, content: result.content });
          }
          continue;
        }

        const verdicts = this.parseVerifyResponse(response.text);
        this.recordTelemetry(
          withResultMetadata(request.telemetry, { verdictCount: verdicts.length, toolRounds }),
          startedAt,
          "ok",
          totalUsage,
        );
        return { verdicts, toolRounds };
      }
    } catch (error: unknown) {
      this.recordTelemetry(
        request.telemetry,
        startedAt,
        "error",
        undefined,
        error instanceof Error ? error.message : "Unknown LLM verify error",
      );
      throw this.asRateLimit(error);
    }
  }

  // A failing tool must not abort verification: the model is told what went
  // wrong and rules on the evidence it does have.
  private async runTool(executeTool: LlmToolExecutor, call: LlmToolCall): Promise<string> {
    try {
      return await executeTool(call.name, call.input);
    } catch (error: unknown) {
      return `ERROR: ${error instanceof Error ? error.message : "tool failed"}`;
    }
  }

  private asRateLimit(error: unknown): unknown {
    if (this.provider.isRateLimitError(error)) {
      return new RateLimitError("LLM API rate limit exceeded");
    }
    return error;
  }

  private parseReviewResponse(text: string): LlmReviewResponse {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const jsonStr = jsonMatch[1]!.trim();

    try {
      const parsed = JSON.parse(jsonStr);
      const findings = Array.isArray(parsed.findings)
        ? (parsed.findings as unknown[])
            .map((finding: unknown) => normalizeFinding(finding))
            .filter((finding): finding is NonNullable<typeof finding> => finding !== null)
        : [];
      return {
        findings,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
      };
    } catch {
      console.error(
        `LLM review response was not valid JSON; treating as zero findings. First 200 chars: ${text.slice(0, 200)}`,
      );
      return { findings: [], summary: text };
    }
  }

  private parseVerifyResponse(text: string): LlmVerifyVerdict[] {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const jsonStr = jsonMatch[1]!.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      throw new Error("LLM verify response was not valid JSON");
    }

    const rawVerdicts = (parsed as { verdicts?: unknown }).verdicts;
    if (!Array.isArray(rawVerdicts)) {
      throw new Error("LLM verify response had no verdicts array");
    }

    const validKinds = new Set<VerifyVerdictKind>(["confirm", "demote", "reject"]);
    const verdicts: LlmVerifyVerdict[] = [];
    for (const entry of rawVerdicts) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const index = record.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) continue;
      const verdict = record.verdict;
      if (typeof verdict !== "string" || !validKinds.has(verdict as VerifyVerdictKind)) continue;
      const reason = record.reason == null ? "" : String(record.reason);
      verdicts.push({ index, verdict: verdict as VerifyVerdictKind, reason });
    }
    return verdicts;
  }

  private parseFixResponse(text: string): LlmFixResponse {
    const codeMatch = text.match(/```(?:\w+)?[^\S\r\n]*(?:\r?\n)?([\s\S]*?)```/);
    const patch = codeMatch ? stripFencePadding(codeMatch[1]!) : text.trim();
    return { patch };
  }

  private recordTelemetry(
    context: ClaudeActionContext | undefined,
    startedAt: Date,
    status: "ok" | "error",
    usage?: NormalizedUsage,
    error?: string,
  ): void {
    if (!this.telemetry || !context) return;
    this.telemetry.record(
      buildLlmTelemetryAction({
        runId: this.runId,
        context,
        provider: this.provider.id,
        model: this.model,
        startedAt,
        endedAt: new Date(),
        usage: usage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
        },
        status,
        error,
        pricingOverride: this.pricingOverride,
      }),
    );
  }
}

function toBlocks(systemPrompt: LlmSystemPrompt): LlmSystemBlock[] {
  return typeof systemPrompt === "string" ? [{ text: systemPrompt }] : systemPrompt;
}

function accumulate(total: NormalizedUsage, usage: NormalizedUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
}

function withResultMetadata(
  context: ClaudeActionContext | undefined,
  metadata: Record<string, unknown>,
): ClaudeActionContext | undefined {
  if (!context) return undefined;
  return { ...context, metadata: { ...context.metadata, ...metadata } };
}

function stripFencePadding(content: string): string {
  let fixedContent = content;
  if (fixedContent.startsWith("\r\n")) fixedContent = fixedContent.slice(2);
  else if (fixedContent.startsWith("\n")) fixedContent = fixedContent.slice(1);
  if (fixedContent.endsWith("\r\n")) fixedContent = fixedContent.slice(0, -2);
  else if (fixedContent.endsWith("\n")) fixedContent = fixedContent.slice(0, -1);
  return fixedContent;
}
