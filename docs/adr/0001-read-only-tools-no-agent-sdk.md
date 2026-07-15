# ADR 0001 — Read-only tools for the model; no write tools, no Agent SDK

**Status:** Accepted

## Context

GitAgents calls Claude for three things: reviewing a diff, verifying its own
findings, and generating fixes. All three go through a single `ClaudeClient` on
the Anthropic Messages API, which gives us one place for retries, rate-limit
handling, prompt caching, and cost/telemetry.

Two capabilities are tempting to reach for:

- Giving the model **tools that act** — post a comment, push a commit, set a
  label — so it can "just do it."
- Adopting the **Claude Agent SDK**, which wraps the tool-use loop and ships a
  managed harness, filesystem/bash tools, subagents, and session handling.

## Decision

The model is only ever given **read-only** tools, and we do **not** use the
Agent SDK. Every action with a side effect — posting comments, resolving
threads, applying labels, committing fixes, and above all deciding what blocks a
merge — is performed by ordinary deterministic code.

The one place the model uses tools at all is the **verification pass**, and only
to gather evidence: `read_file` and `search_repo` over the checkout the CI job
already has on disk. The loop is bounded by a small per-file round budget and
fails open — if verification cannot complete, findings are kept exactly as they
were.

## Why not give the model write tools

The value of this bot is precision, and precision here is enforced in code, not
requested in a prompt:

- A finding can block a merge only when it is an error, high-confidence, raised
  by a rule marked `gate: true`, and confirmed by verification — four conditions
  checked in code.
- Suggested fixes are validated against an over-edit window and reduced to a
  minimal contiguous replacement span by deterministic diffing.

Handing the model a `post_comment` or `push_commit` tool would move those
decisions back inside the model — exactly the authority this design removes.
Read-only tools cannot do that.

## Why not the Agent SDK

The SDK earns its keep when you need genuine multi-step autonomy: a fleet of
tools, command execution, subagents, managed sessions. Our need is one bounded
classification with two read-only tools, implemented as a small loop inside the
existing client.

Adopting the SDK for that one component would:

- introduce a second dependency, a second loop implementation, and a second
  failure mode;
- bypass the shared retry, rate-limit, prompt-cache, and telemetry paths every
  other call already uses — or force us to re-wrap the SDK to get them back;
- for no capability we actually use.

If verification ever grows into real autonomous, multi-tool, command-running
work, revisiting the SDK is the right move. It is a scale threshold, not a style
preference, and this component is nowhere near it.

## Consequences

- One client, one loop, one telemetry path.
- The model cannot take an action that is not mediated by reviewed code.
- Verification is more precise than a prompt-only pass, because it can read the
  callee or find the guard instead of guessing — while remaining unable to
  invent a blocker.
