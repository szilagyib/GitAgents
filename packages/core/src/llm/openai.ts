import OpenAI from "openai";
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

export interface OpenAiProviderOptions {
  apiKey: string;
  baseURL?: string;
}

/**
 * Adapter over the openai SDK (Chat Completions). Works against any
 * OpenAI-compatible endpoint via `baseURL` (Azure, OpenRouter, local runtimes).
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = "openai" as const;
  private client: OpenAI;

  constructor(opts: OpenAiProviderOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async createMessage(req: LlmMessageRequest): Promise<LlmMessageResponse> {
    const response = await this.client.chat.completions.create(
      {
        model: req.model,
        // Newer models require max_completion_tokens; temperature is intentionally omitted.
        max_completion_tokens: req.maxTokens,
        messages: toMessages(req.system, req.messages),
        ...(req.tools?.length ? { tools: toTools(req.tools) } : {}),
      },
      { timeout: req.timeoutMs },
    );
    return normalizeResponse(response);
  }

  isTransientError(err: unknown): boolean {
    if (err instanceof OpenAI.APIError) {
      return err.status === 429 || (typeof err.status === "number" && err.status >= 500 && err.status < 600);
    }
    if (err instanceof Error) return NETWORK_ERROR.test(err.message);
    return false;
  }

  isRateLimitError(err: unknown): boolean {
    return err instanceof OpenAI.APIError && err.status === 429;
  }
}

function toMessages(
  system: LlmSystemBlock[],
  messages: LlmMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (system.length) {
    out.push({ role: "system", content: system.map((b) => b.text).join("\n\n") });
  }
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: message.text.length > 0 ? message.text : null,
      };
      if (message.toolCalls.length) {
        assistant.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }));
      }
      out.push(assistant);
    } else {
      out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
    }
  }
  return out;
}

function toTools(tools: LlmToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function normalizeResponse(
  response: OpenAI.Chat.Completions.ChatCompletion,
): LlmMessageResponse {
  const choice = response.choices[0];
  const message = choice?.message;

  const toolCalls: LlmToolCall[] = (message?.tool_calls ?? [])
    .filter((call) => call.type === "function")
    .map((call) => ({
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    }));

  return {
    text: message?.content ?? "",
    toolCalls,
    stopReason: toStopReason(choice?.finish_reason),
    usage: toUsage(response.usage),
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toStopReason(reason: string | null | undefined): LlmStopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "other";
  }
}

// OpenAI's prompt_tokens already includes cached tokens, so subtract them out to
// avoid double-counting: uncached input is billed in full, cached at the read rate.
function toUsage(usage: OpenAI.Completions.CompletionUsage | undefined): NormalizedUsage {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheWriteTokens: 0,
    cacheReadTokens: cached,
  };
}
