---
extensions: [.ts, .tsx, .js, .jsx, .mts, .mjs, .cts, .cjs]
---
# TypeScript Review Rules

## naming-conventions
severity: warning
PascalCase for types/interfaces. camelCase for variables/functions. No I-prefix on interfaces.

## strict-typing
severity: error
Flag a new, unjustified `any` introduced on a changed line. tsc and eslint own the mechanical checks (strict equality, unused narrowing) — do not duplicate them; focus on `any` that discards type safety without a stated reason.

## async-errors
severity: error
signals: [async]
Flag a promise with no rejection handler anywhere on the visible path: a floating (unawaited) async call, or a fire-and-forget that silently swallows errors. Propagating a rejection to the caller by not catching it is correct design — do not flag a missing try/catch inside an async function.

## request-validation
severity: error
profiles: [node-server]
signals: [server, external-input]
Flag unvalidated request params, body, query, headers, env vars, or JSON.parse results only when the visible code is the trust boundary that consumes them directly. Do not assume validation is missing because a caller or middleware you cannot see may already narrow the data.

## callback-promise-mismatch
severity: error
gate: true
signals: [callback]
requiredSignals: [async]
Flag async functions passed as callbacks to APIs that ignore the returned promise (Array.forEach, EventEmitter.on, Express middleware without next).

## exhaustive-switch
severity: error
signals: [branching]
Flag a switch/if-else on a union or enum that misses a variant only when the full set of variants is visible in context and there is no default or fallthrough handling. Do not flag when the union is defined elsewhere and you cannot enumerate it.

## react-hooks
severity: error
profiles: [react-ui]
signals: [react]
For React code, flag mechanical Rules-of-Hooks violations as errors: conditional hooks, hooks in loops, missing effect cleanup, unstable keys. Treat heuristic concerns — stale closures, derived-state bugs, effects that set state from stale props — as lower-confidence advice, not blocking findings.

## server-side-security
severity: error
profiles: [node-server]
signals: [server]
For Node/server code, flag SQL/NoSQL injection, path traversal, SSRF, prototype pollution, unsafe redirects, and command injection.

## type-assertion-abuse
severity: warning
Flag unsafe as casts and ! non-null assertions that bypass the type system without justification.

## closure-pitfalls
severity: warning
signals: [react, callback]
Flag stale closures in callbacks, useEffect, setTimeout, or event listeners referencing outdated values.

## prototype-pollution
severity: error
gate: true
signals: [dynamic-key]
requiredSignals: [external-input]
Flag merging/assigning to objects using dynamic keys from external input.

## serialization-contracts
severity: error
Flag changed JSON shapes, renamed fields, changed status codes, or changed error formats only when a visible external consumer depends on the old shape (a persisted format, a wire contract, or a documented API surface). Do not flag internal shapes with no visible external consumer.

## equality-coercion
severity: warning
Flag implicit boolean coercion of non-boolean values (e.g., if (count) when 0 is valid) and + operator on mixed types.
