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
  private metadata?: Record<string, unknown>;
  private pending: Array<Promise<void>> = [];

  constructor(options: DashboardTelemetryRecorderOptions) {
    this.dashboardUrl = options.dashboardUrl.replace(/\/$/, "");
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
    const response = await fetch(`${this.dashboardUrl}/api/telemetry/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
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

export function buildClaudeTelemetryAction(input: {
  runId: string;
  context: ClaudeActionContext;
  model: string;
  startedAt: Date;
  endedAt: Date;
  usage?: unknown;
  status: "ok" | "error";
  error?: string;
}): AgentActionTelemetry {
  const tokens = parseTokenUsage(input.usage);
  const pricing = getClaudePricing(input.model);
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

export function getClaudePricing(model: string): ClaudePricing {
  const normalized = model.toLowerCase();

  if (normalized.includes("haiku-3-5") || normalized.includes("haiku-3.5")) {
    return {
      inputPerMillion: 0.8,
      outputPerMillion: 4,
      cacheWritePerMillion: 1,
      cacheReadPerMillion: 0.08,
    };
  }

  if (normalized.includes("haiku")) {
    return {
      inputPerMillion: 1,
      outputPerMillion: 5,
      cacheWritePerMillion: 1.25,
      cacheReadPerMillion: 0.1,
    };
  }

  if (
    normalized.includes("opus-4-7") ||
    normalized.includes("opus-4.7") ||
    normalized.includes("opus-4-6") ||
    normalized.includes("opus-4.6") ||
    normalized.includes("opus-4-5") ||
    normalized.includes("opus-4.5")
  ) {
    return {
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheWritePerMillion: 6.25,
      cacheReadPerMillion: 0.5,
    };
  }

  if (normalized.includes("opus")) {
    return {
      inputPerMillion: 15,
      outputPerMillion: 75,
      cacheWritePerMillion: 18.75,
      cacheReadPerMillion: 1.5,
    };
  }

  return {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  };
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
