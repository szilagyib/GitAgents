import { getModelPricing, type ModelPricingOverride } from "./llm/pricing.js";
import type { LlmProviderId, NormalizedUsage } from "./llm/provider.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
}

export interface ClaudePricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

export interface AgentActionTelemetry {
  id: string;
  runId: string;
  agent: string;
  action: string;
  target?: string;
  model?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  tokens: TokenUsage;
  costUsd: number;
  pricing: ClaudePricing;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TelemetryArtifact {
  version: 1;
  generatedAt: string;
  currency: "USD";
  pricingSource: string;
  actions: AgentActionTelemetry[];
}

export interface ClaudeActionContext {
  agent: string;
  action: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export interface TelemetrySink {
  record(action: AgentActionTelemetry): void;
}

export interface DashboardTelemetryRecorderOptions {
  dashboardUrl: string;
  token?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export const TELEMETRY_PRICING_SOURCE =
  "https://platform.claude.com/docs/en/docs/about-claude/pricing";

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0,
};

export class DashboardTelemetryRecorder implements TelemetrySink {
  readonly dashboardUrl: string;
  readonly runId: string;
  private readonly token?: string;
  private metadata?: Record<string, unknown>;
  private pending: Array<Promise<void>> = [];

  constructor(options: DashboardTelemetryRecorderOptions) {
    this.dashboardUrl = options.dashboardUrl.replace(/\/$/, "");
    this.token = options.token?.trim() || undefined;
    this.runId = options.runId ?? createId("run");
    this.metadata = options.metadata;
  }

  record(action: AgentActionTelemetry): void {
    const promise = this.post(action).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown dashboard telemetry error";
      console.warn(`Could not send telemetry to dashboard: ${message}`);
    });
    this.pending.push(promise);
  }

  async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    await Promise.all(pending);
  }

  private async post(action: AgentActionTelemetry): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const response = await fetch(`${this.dashboardUrl}/api/telemetry/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action,
        metadata: this.metadata,
      }),
    });

    if (!response.ok) {
      throw new Error(`Dashboard API ${response.status}: ${await response.text()}`);
    }
  }
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function buildLlmTelemetryAction(input: {
  runId: string;
  context: ClaudeActionContext;
  provider: LlmProviderId;
  model: string;
  startedAt: Date;
  endedAt: Date;
  usage: NormalizedUsage;
  status: "ok" | "error";
  error?: string;
  pricingOverride?: ModelPricingOverride;
}): AgentActionTelemetry {
  const tokens = usageToTokenUsage(input.usage);
  const pricing = getModelPricing(input.provider, input.model, input.pricingOverride);
  return {
    id: createId("act"),
    runId: input.runId,
    agent: input.context.agent,
    action: input.context.action,
    target: input.context.target,
    model: input.model,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
    status: input.status,
    tokens,
    costUsd: calculateClaudeCost(tokens, pricing),
    pricing,
    error: input.error,
    metadata: input.context.metadata,
  };
}

function usageToTokenUsage(usage: NormalizedUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheWriteTokens,
    cacheReadInputTokens: usage.cacheReadTokens,
    totalTokens:
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheWriteTokens +
      usage.cacheReadTokens,
  };
}

export function parseTokenUsage(usage: unknown): TokenUsage {
  if (typeof usage !== "object" || usage === null) {
    return { ...EMPTY_USAGE };
  }

  const record = usage as Record<string, unknown>;
  const inputTokens = readNumber(record, "input_tokens");
  const outputTokens = readNumber(record, "output_tokens");
  const cacheCreationInputTokens = readNumber(
    record,
    "cache_creation_input_tokens",
  );
  const cacheReadInputTokens = readNumber(record, "cache_read_input_tokens");

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      inputTokens +
      outputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens,
  };
}

export function calculateClaudeCost(
  usage: TokenUsage,
  pricing: ClaudePricing,
): number {
  const cost =
    (usage.inputTokens * pricing.inputPerMillion +
      usage.outputTokens * pricing.outputPerMillion +
      usage.cacheCreationInputTokens * pricing.cacheWritePerMillion +
      usage.cacheReadInputTokens * pricing.cacheReadPerMillion) /
    1_000_000;
  return Number(cost.toFixed(8));
}

/** Anthropic pricing by model name. Kept for callers that price Claude models directly. */
export function getClaudePricing(model: string): ClaudePricing {
  return getModelPricing("anthropic", model);
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
