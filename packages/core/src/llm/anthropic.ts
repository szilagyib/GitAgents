import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmMessage,
  LlmMessageRequest,
  LlmMessageResponse,
  LlmProvider,
  LlmStopReason,
  LlmSystemBlock,
  LlmToolCall,
  LlmToolSpec,
  NormalizedUsage,
} from "./provider.js";

const NETWORK_ERROR = /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i;

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
}

/** Adapter over @anthropic-ai/sdk. Translates normalized requests/responses. */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic" as const;
  private client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async createMessage(req: LlmMessageRequest): Promise<LlmMessageResponse> {
    const response = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: toSystem(req.system),
        messages: toMessages(req.messages),
        ...(req.tools?.length ? { tools: toTools(req.tools) } : {}),
      },
      { timeout: req.timeoutMs },
    );
    return normalizeResponse(response);
  }

  isTransientError(err: unknown): boolean {
    if (err instanceof Anthropic.APIError) {
      return err.status === 429 || (err.status >= 500 && err.status < 600);
    }
    if (err instanceof Error) return NETWORK_ERROR.test(err.message);
    return false;
  }

  isRateLimitError(err: unknown): boolean {
    return err instanceof Anthropic.APIError && err.status === 429;
  }
}

function toSystem(system: LlmSystemBlock[]): Anthropic.TextBlockParam[] {
  return system.map((block) => ({
    type: "text" as const,
    text: block.text,
    ...(block.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

function toTools(tools: LlmToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}

function toMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    // tool_result — coalesce runs of results into a single user turn, as the
    // Messages API expects all results for one assistant turn together.
    const block: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    };
    const last = out[out.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

function normalizeResponse(response: Anthropic.Message): LlmMessageResponse {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const toolCalls: LlmToolCall[] = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));

  return {
    text,
    toolCalls,
    stopReason: toStopReason(response.stop_reason),
    usage: toUsage(response.usage),
  };
}

function toStopReason(reason: string | null): LlmStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    default:
      return "other";
  }
}

function toUsage(usage: Anthropic.Usage | undefined): NormalizedUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
  };
}
