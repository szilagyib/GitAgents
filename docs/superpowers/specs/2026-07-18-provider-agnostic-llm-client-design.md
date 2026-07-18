# Provider-agnostic LLM client — design

**Date:** 2026-07-18
**Status:** Approved, pending implementation plan

## Summary

GitAgents currently talks to Anthropic only: `ClaudeClient` (`packages/core/src/claude/client.ts`) wraps `@anthropic-ai/sdk` directly, and cost telemetry (`packages/core/src/telemetry.ts`) parses Anthropic's token fields and prices by matching Claude model-name substrings.

This change lets a run target **either Anthropic (default) or any OpenAI Chat-Completions-compatible provider** — OpenAI, Azure OpenAI, OpenRouter, Together, or a local Ollama/vLLM endpoint — selected by environment variables. Anthropic stays the default, so existing setups keep working with no config change.

## Scope

**In scope**
- Two API shapes behind one interface: Anthropic Messages, and OpenAI Chat Completions with a configurable base URL.
- The review, fix, and adversarial-verify flows, including the read-only tool-use loop (`read_file` / `search_repo`), working on both shapes.
- Best-effort cost tracking: built-in price tables for Anthropic + common OpenAI models, an optional per-model price override, and graceful token-only tracking (`$0`) for unknown models.
- Backward compatibility: `CLAUDE_API_KEY` alone → Anthropic + today's default model, behavior identical.

**Non-goals (YAGNI)**
- Streaming responses (current code is non-streaming; keep it).
- Per-agent / per-role model selection (all call sites use one default today).
- Provider-specific structured-output / JSON modes (we keep parsing JSON from text for parity).
- A general plugin registry for many first-class providers.
- Reasoning-model-specific handling beyond what `chat.completions` does by default (e.g. `developer` role).

## Approach

**Thin provider adapter + shared orchestration.** One small `LlmProvider` interface does only the provider-specific work — send a normalized message, return a normalized response, classify errors. All review/fix/verify orchestration, JSON parsing, the tool-use loop, retry, and telemetry stay in one shared, provider-neutral place. This mirrors the existing `forge` package (one interface, GitLab + GitHub adapters) and preserves ADR 0001's deterministic orchestration.

### Rejected alternatives
- **Single OpenAI-shaped adapter for everything** (Anthropic exposes an OpenAI-compatible endpoint, so route both through the OpenAI SDK + base-URL swap). Rejected: it forfeits Anthropic prompt caching (`cache_control`). The cost model leans on cache reads heavily (~68% of tokens in production telemetry); losing it would balloon the default path's cost. Keep the native Anthropic adapter.
- **High-level provider interface** (each provider implements review/fix/verify itself). Rejected: duplicates the parsing and tool loop per provider, larger test surface.
- **A multi-provider SDK (LangChain, etc.).** Rejected: heavy dependency, less control over the tool loop and cost telemetry, conflicts with ADR 0001 (no agent SDK).

## Architecture

```
packages/core/src/llm/
  provider.ts    LlmProvider interface + normalized request/response/usage/tool types
  client.ts      LlmClient — review/fix/verify orchestration (was claude/client.ts), provider-neutral
  anthropic.ts   AnthropicProvider adapter (wraps @anthropic-ai/sdk)
  openai.ts      OpenAiProvider adapter (wraps openai, configurable baseURL)
  pricing.ts     getModelPricing(provider, model) — price tables + override
  config.ts      resolveLlmConfig(env) + createLlmClient() factory
```

### The interface (the only thing providers implement)

```ts
interface LlmProvider {
  readonly id: "anthropic" | "openai";
  createMessage(req: LlmMessageRequest): Promise<LlmMessageResponse>;
  isTransientError(err: unknown): boolean;   // 429 or 5xx or network → retry
  isRateLimitError(err: unknown): boolean;   // 429 → surface as RateLimitError
}
```

### Normalized types

```ts
interface LlmSystemBlock { text: string; cacheable?: boolean; }

type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: LlmToolCall[] }   // preserved for replay
  | { role: "tool_result"; toolCallId: string; content: string };

interface LlmToolSpec { name: string; description: string; parameters: Record<string, unknown>; } // JSON Schema
interface LlmToolCall { id: string; name: string; input: Record<string, unknown>; }

interface LlmMessageRequest {
  model: string;
  maxTokens: number;
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  timeoutMs?: number;
}

interface NormalizedUsage {
  inputTokens: number;        // uncached input only
  outputTokens: number;
  cacheWriteTokens: number;   // Anthropic cache creation; 0 for OpenAI
  cacheReadTokens: number;    // Anthropic cache read; OpenAI cached_tokens
}

interface LlmMessageResponse {
  text: string;                                        // concatenated text output
  toolCalls: LlmToolCall[];
  stopReason: "end" | "max_tokens" | "tool_use" | "other";
  usage: NormalizedUsage;
}
```

The `assistant` message keeps `text` + `toolCalls` (with ids) so each adapter can replay the tool-calling turn in its native format.

## Orchestration (`LlmClient`)

`review()`, `fix()`, `verifyFindings()` keep their current behavior and public request/response shapes (renamed `Claude*` → `Llm*`). Changes:

- All API calls go through `provider.createMessage(...)`.
- `withRetry` uses `provider.isTransientError`; a `provider.isRateLimitError` hit is rethrown as the existing `RateLimitError` (callers fail open).
- The verify tool loop iterates over `response.toolCalls`, appends a normalized `assistant` message then `tool_result` messages, bounded by `maxToolRounds` exactly as today. Truncation (`stopReason === "max_tokens"`) and budget-exhaustion still throw so verification fails open.
- JSON parsing of review/verify/fix output is unchanged (fenced-JSON tolerant, text-based).
- Telemetry receives `NormalizedUsage` directly instead of parsing a raw Anthropic object.

## Adapters

### AnthropicProvider
- `system`: `LlmSystemBlock[]` → text blocks, `cacheable` → `cache_control: { type: "ephemeral" }`.
- `messages`: normalized → Anthropic `MessageParam` (`assistant` → `content` with text + `tool_use` blocks; `tool_result` → user message with `tool_result` block).
- `tools`: `LlmToolSpec` → `{ name, description, input_schema: parameters }`.
- Response: `content` → concatenated text + `tool_use` blocks → `LlmToolCall[]` (input is already an object). `stop_reason` → normalized `stopReason` (`end_turn`/`stop_sequence` → `end`, `max_tokens` → `max_tokens`, `tool_use` → `tool_use`).
- Usage: `input_tokens → inputTokens`, `output_tokens → outputTokens`, `cache_creation_input_tokens → cacheWriteTokens`, `cache_read_input_tokens → cacheReadTokens`.
- Errors: `Anthropic.APIError` → `isTransientError` (429/5xx), `isRateLimitError` (429).

### OpenAiProvider
- `system`: concatenate blocks into a single `system` message; `cacheable` ignored (OpenAI caches automatically).
- `messages`: normalized → OpenAI messages (`assistant` → `{ role:"assistant", content, tool_calls }`; `tool_result` → `{ role:"tool", tool_call_id, content }`).
- `tools`: `LlmToolSpec` → `{ type:"function", function:{ name, description, parameters } }`.
- Response: `choices[0].message.content` → text; `tool_calls` → `LlmToolCall[]`, **parsing `function.arguments` (a JSON string) into `input`**. `finish_reason` → normalized `stopReason` (`tool_calls` → `tool_use`, `length` → `max_tokens`).
- **Usage normalization (avoids double-count):** `prompt_tokens` *includes* `prompt_tokens_details.cached_tokens`, so `inputTokens = prompt_tokens − cached_tokens`, `cacheReadTokens = cached_tokens`, `cacheWriteTokens = 0`, `outputTokens = completion_tokens`.
- **Params:** use `max_completion_tokens` (not `max_tokens`); do **not** send `temperature`.
- `baseURL` from config (Azure/OpenRouter/local); errors via `OpenAI.APIError` (429/5xx / 429).

## Verify tool specs

`packages/review-agent/src/repo-tools.ts` currently defines `REPO_TOOLS` in Anthropic-native shape (`input_schema`). Neutralize to `LlmToolSpec` (`{ name, description, parameters }`); the core type `ClaudeToolSpec` (`input_schema`) → `LlmToolSpec` (`parameters`). Each adapter maps to its native tool shape. The tool executor and `verifier.ts` / `orchestrator.ts` wiring are otherwise unchanged.

## Config

Environment-driven (CI passes env). A `resolveLlmConfig(env)` builds the config; `createLlmClient(env, { telemetry, runId })` returns a wired `LlmClient`.

| Variable | Meaning |
|---|---|
| `GITAGENTS_PROVIDER` | `anthropic` *(default)* or `openai` |
| `CLAUDE_API_KEY` / `OPENAI_API_KEY` | provider key; generic `GITAGENTS_LLM_API_KEY` used as fallback |
| `GITAGENTS_MODEL` | model id; default `claude-sonnet-4-6` for anthropic; **required** for openai (clear error if unset) |
| `GITAGENTS_BASE_URL` | optional base URL (Azure/OpenRouter/local) |
| `GITAGENTS_MODEL_PRICING` | optional JSON price override (see below) |

Resolution: provider-specific key first, then `GITAGENTS_LLM_API_KEY`. With only `CLAUDE_API_KEY` set (today's state) → Anthropic + default model, identical to current behavior.

The three construction sites (`review-agent/src/cli.ts`, `fix-agent/src/cli.ts` ×2) call `createLlmClient(...)` instead of `new ClaudeClient(apiKey, undefined, telemetry, runId)`.

## Telemetry & pricing

- `TokenUsage` stays; it is populated from `NormalizedUsage` rather than parsed from a raw Anthropic object. `parseTokenUsage(raw)` is retired in favor of taking `NormalizedUsage`.
- `buildClaudeTelemetryAction(...)` → `buildLlmTelemetryAction(...)`, taking the `provider` id + `NormalizedUsage` (pricing now needs the provider). `TELEMETRY_PRICING_SOURCE` stays a single constant (metadata only; unchanged).
- `ClaudePricing` → `ModelPricing` (same fields: `inputPerMillion`, `outputPerMillion`, `cacheWritePerMillion`, `cacheReadPerMillion`).
- `getClaudePricing(model)` → `getModelPricing(provider, model)`:
  - Keep the existing Anthropic tables.
  - Add tables for common OpenAI `gpt-*` models.
  - Apply `GITAGENTS_MODEL_PRICING` override when the model matches.
  - Unknown model → all-zero pricing; tokens still tracked, `costUsd = 0`.
- Artifact JSON keys (`pricing`, `costUsd`, `tokens`) are unchanged, so the dashboard needs **no change**. (An "unpriced" badge is deliberately out of scope.)

Override shape:
```json
{ "gpt-4.1": { "inputPerMillion": 2, "outputPerMillion": 8, "cacheWritePerMillion": 0, "cacheReadPerMillion": 0.5 } }
```

## Backward compatibility

- Default provider = anthropic; default model unchanged.
- `CLAUDE_API_KEY` remains the Anthropic key.
- Existing Anthropic behavior (prompt caching, tool loop, cost) is unchanged. The in-progress 3-repo CI setup keeps working with no edits.

## Testing

- **Adapter tests** — mock `@anthropic-ai/sdk` for AnthropicProvider and `openai` for OpenAiProvider. Each verifies translation both directions: normalized request → SDK payload, and SDK response → normalized (text, tool calls, `stopReason`, usage). Explicit cases for the correctness details: OpenAI `cached_tokens` subtraction, `arguments` JSON parse, `max_completion_tokens`, tool-turn replay.
- **Orchestration** — the existing review/fix/verify tests run through AnthropicProvider with the SDK mocked (Anthropic is the default), so they change minimally. Where a test needs to check the loop independent of a provider, stub the single `createMessage` call with `vi.fn()` — no dedicated fake class.
- **New** — an OpenAI verify-with-tools round-trip test (tool call → tool_result → final verdict) proving the loop is provider-neutral.

## Dependencies

Add `openai` to `packages/core`.

## Files touched

**Added:** `packages/core/src/llm/{provider,client,anthropic,openai,pricing,config}.ts` (+ tests).
**Moved/renamed:** `packages/core/src/claude/*` → `llm/*`; `Claude*` request/response/tool types → `Llm*`.
**Edited:** `packages/core/src/telemetry.ts` (NormalizedUsage in, `getModelPricing`), `packages/review-agent/src/repo-tools.ts` (`input_schema` → `parameters`), `packages/review-agent/src/{verifier,orchestrator}.ts` (type names), `packages/review-agent/src/cli.ts` + `packages/fix-agent/src/cli.ts` (use `createLlmClient`), `packages/core/package.json` (add `openai`), affected tests.

## Correctness checklist (must hold in implementation)

1. OpenAI `inputTokens = prompt_tokens − cached_tokens` (no double-count).
2. OpenAI tool-call `arguments` parsed from JSON string to object.
3. Assistant tool-call turn replayed each round with ids preserved.
4. OpenAI uses `max_completion_tokens`; no `temperature` sent to either provider.
5. JSON parsed from text for both providers (no provider-specific JSON mode).
6. Verify still fails open on truncation / budget exhaustion / rate limit.
