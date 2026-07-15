import Anthropic from "@anthropic-ai/sdk";
import type {
  ClaudeSystemPrompt,
  ClaudeReviewRequest,
  ClaudeReviewResponse,
  ClaudeFixRequest,
  ClaudeFixResponse,
  ClaudeVerifyRequest,
  ClaudeVerifyResponse,
  ClaudeVerifyVerdict,
  ClaudeToolExecutor,
  VerifyVerdictKind,
} from "./types.js";
import { normalizeFinding } from "../types.js";
import { withRetry } from "../retry.js";
import {
  buildClaudeTelemetryAction,
  type ClaudeActionContext,
  type TelemetrySink,
} from "../telemetry.js";

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

function isTransientClaudeError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  if (err instanceof Error) {
    return /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(err.message);
  }
  return false;
}

export class ClaudeClient {
  private client: Anthropic;
  private model = "claude-sonnet-4-6";
  private telemetry?: TelemetrySink;
  private runId: string;

  constructor(apiKey: string, model?: string, telemetry?: TelemetrySink, runId?: string) {
    this.client = new Anthropic({ apiKey });
    if (model) this.model = model;
    this.telemetry = telemetry;
    this.runId = runId ?? "default";
  }

  async review(request: ClaudeReviewRequest): Promise<ClaudeReviewResponse> {
    const startedAt = new Date();
    try {
      const response = await withRetry(
        () =>
          this.client.messages.create(
            {
              model: this.model,
              max_tokens: request.maxTokens,
              system: this.buildSystemPrompt(request.systemPrompt),
              messages: [{ role: "user", content: request.userPrompt }],
            },
            { timeout: request.timeoutMs },
          ),
        { shouldRetry: isTransientClaudeError },
      );

      if (response.stop_reason === "max_tokens") {
        console.error(
          "Claude review response was truncated (max_tokens); findings may be incomplete.",
        );
      }

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      const parsed = this.parseReviewResponse(text);
      this.recordTelemetry(
        this.withResultMetadata(request.telemetry, {
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
        error instanceof Error ? error.message : "Unknown Claude review error",
      );
      if (error instanceof Anthropic.APIError && error.status === 429) {
        throw new RateLimitError("Claude API rate limit exceeded");
      }
      throw error;
    }
  }

  async fix(request: ClaudeFixRequest): Promise<ClaudeFixResponse> {
    const startedAt = new Date();
    try {
      const response = await withRetry(
        () =>
          this.client.messages.create(
            {
              model: this.model,
              max_tokens: request.maxTokens,
              system: this.buildSystemPrompt(request.systemPrompt),
              messages: [
                {
                  role: "user",
                  content: request.userPrompt,
                },
              ],
            },
            { timeout: request.timeoutMs },
          ),
        { shouldRetry: isTransientClaudeError },
      );

      const text =
        response.content[0].type === "text" ? response.content[0].text : "";
      this.recordTelemetry(request.telemetry, startedAt, "ok", response.usage);
      return this.parseFixResponse(text);
    } catch (error: unknown) {
      this.recordTelemetry(
        request.telemetry,
        startedAt,
        "error",
        undefined,
        error instanceof Error ? error.message : "Unknown Claude fix error",
      );
      if (error instanceof Anthropic.APIError && error.status === 429) {
        throw new RateLimitError("Claude API rate limit exceeded");
      }
      throw error;
    }
  }

  /**
   * Adversarial verification, optionally with read-only evidence tools.
   *
   * When `tools` are supplied the model may request file reads/searches before
   * ruling; each round-trip is bounded by `maxToolRounds` so a file's cost stays
   * predictable. Usage across every round is summed into one telemetry action.
   * The tools are strictly read-only by design — see ClaudeVerifyRequest.
   */
  async verifyFindings(request: ClaudeVerifyRequest): Promise<ClaudeVerifyResponse> {
    const startedAt = new Date();
    const maxToolRounds = request.tools?.length ? (request.maxToolRounds ?? 0) : 0;
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: request.userPrompt },
    ];
    const totalUsage = { input_tokens: 0, output_tokens: 0 } as Record<string, number>;
    let toolRounds = 0;

    try {
      for (let round = 0; ; round++) {
        const response = await withRetry(
          () =>
            this.client.messages.create(
              {
                model: this.model,
                max_tokens: request.maxTokens,
                system: this.buildSystemPrompt(request.systemPrompt),
                messages,
                ...(maxToolRounds > 0 && request.tools
                  ? { tools: request.tools as Anthropic.Tool[] }
                  : {}),
              },
              { timeout: request.timeoutMs },
            ),
          { shouldRetry: isTransientClaudeError },
        );

        this.accumulateUsage(totalUsage, response.usage);

        if (response.stop_reason === "max_tokens") {
          // Verification is treated as unavailable when truncated; callers fail open.
          throw new Error("Claude verify response truncated (max_tokens)");
        }

        const toolUses = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );

        if (
          response.stop_reason === "tool_use" &&
          toolUses.length > 0 &&
          request.executeTool
        ) {
          if (round >= maxToolRounds) {
            // Out of budget: make the model rule on what it already has rather
            // than dropping verification for this file entirely.
            throw new Error(
              `Claude verify exceeded its tool-round budget (${maxToolRounds})`,
            );
          }
          toolRounds++;
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: await Promise.all(
              toolUses.map(async (toolUse) => ({
                type: "tool_result" as const,
                tool_use_id: toolUse.id,
                content: await this.runTool(request.executeTool!, toolUse),
              })),
            ),
          });
          continue;
        }

        const text = response.content.find(
          (block): block is Anthropic.TextBlock => block.type === "text",
        )?.text ?? "";
        const verdicts = this.parseVerifyResponse(text);
        this.recordTelemetry(
          this.withResultMetadata(request.telemetry, {
            verdictCount: verdicts.length,
            toolRounds,
          }),
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
        error instanceof Error ? error.message : "Unknown Claude verify error",
      );
      if (error instanceof Anthropic.APIError && error.status === 429) {
        throw new RateLimitError("Claude API rate limit exceeded");
      }
      throw error;
    }
  }

  // A failing tool must not abort verification: the model is told what went
  // wrong and rules on the evidence it does have.
  private async runTool(
    executeTool: ClaudeToolExecutor,
    toolUse: Anthropic.ToolUseBlock,
  ): Promise<string> {
    try {
      return await executeTool(
        toolUse.name,
        (toolUse.input ?? {}) as Record<string, unknown>,
      );
    } catch (error: unknown) {
      return `ERROR: ${error instanceof Error ? error.message : "tool failed"}`;
    }
  }

  private accumulateUsage(total: Record<string, number>, usage: unknown): void {
    if (!usage || typeof usage !== "object") return;
    for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
      if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
    }
  }

  private parseReviewResponse(text: string): ClaudeReviewResponse {
    // Extract JSON from potential markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [
      null,
      text,
    ];
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
        `Claude review response was not valid JSON; treating as zero findings. First 200 chars: ${text.slice(0, 200)}`,
      );
      return { findings: [], summary: text };
    }
  }

  private parseVerifyResponse(text: string): ClaudeVerifyVerdict[] {
    // Extract JSON from potential markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [
      null,
      text,
    ];
    const jsonStr = jsonMatch[1]!.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Fail open upstream: signal that verification could not be interpreted.
      throw new Error("Claude verify response was not valid JSON");
    }

    const rawVerdicts = (parsed as { verdicts?: unknown }).verdicts;
    if (!Array.isArray(rawVerdicts)) {
      // Fail open upstream: valid JSON without a verdicts array is just as
      // uninterpretable as non-JSON. Returning [] here would demote every
      // finding instead of leaving them untouched.
      throw new Error("Claude verify response had no verdicts array");
    }

    const validKinds = new Set<VerifyVerdictKind>([
      "confirm",
      "demote",
      "reject",
    ]);
    const verdicts: ClaudeVerifyVerdict[] = [];
    for (const entry of rawVerdicts) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const index = record.index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        continue;
      }
      const verdict = record.verdict;
      if (
        typeof verdict !== "string" ||
        !validKinds.has(verdict as VerifyVerdictKind)
      ) {
        continue;
      }
      const reason = record.reason == null ? "" : String(record.reason);
      verdicts.push({ index, verdict: verdict as VerifyVerdictKind, reason });
    }
    return verdicts;
  }

  private buildSystemPrompt(systemPrompt: ClaudeSystemPrompt) {
    if (typeof systemPrompt === "string") return systemPrompt;

    return systemPrompt.map((block) => ({
      type: "text" as const,
      text: block.text,
      ...(block.cacheable
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    }));
  }

  private parseFixResponse(text: string): ClaudeFixResponse {
    // Extract unified diff from markdown code blocks when present.
    const codeMatch = text.match(/```(?:\w+)?[^\S\r\n]*(?:\r?\n)?([\s\S]*?)```/);
    const patch = codeMatch
      ? this.stripFencePadding(codeMatch[1]!)
      : text.trim();
    return { patch };
  }

  private stripFencePadding(content: string): string {
    let fixedContent = content;
    if (fixedContent.startsWith("\r\n")) {
      fixedContent = fixedContent.slice(2);
    } else if (fixedContent.startsWith("\n")) {
      fixedContent = fixedContent.slice(1);
    }
    if (fixedContent.endsWith("\r\n")) {
      fixedContent = fixedContent.slice(0, -2);
    } else if (fixedContent.endsWith("\n")) {
      fixedContent = fixedContent.slice(0, -1);
    }
    return fixedContent;
  }

  private recordTelemetry(
    context: ClaudeActionContext | undefined,
    startedAt: Date,
    status: "ok" | "error",
    usage?: unknown,
    error?: string,
  ): void {
    if (!this.telemetry || !context) return;
    this.telemetry.record(
      buildClaudeTelemetryAction({
        runId: this.runId,
        context,
        model: this.model,
        startedAt,
        endedAt: new Date(),
        usage,
        status,
        error,
      }),
    );
  }

  private withResultMetadata(
    context: ClaudeActionContext | undefined,
    metadata: Record<string, unknown>,
  ): ClaudeActionContext | undefined {
    if (!context) return undefined;
    return {
      ...context,
      metadata: {
        ...context.metadata,
        ...metadata,
      },
    };
  }
}
