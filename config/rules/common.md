# Common Review Rules

## null-safety
severity: error
Flag a null/undefined dereference only when the nullable path is visible in the code: a value checked for null on one branch then dereferenced unchecked on another, an assignment of null/undefined that later flows into a dereference, or a call to an API documented as nullable. If you cannot see where the null originates, do not flag.

## typecasting
severity: error
gate: true
Flag unsafe type casts, unchecked type assertions, and missing instanceof/type guards before casting. Mark autoFixable true when the repair is a local guard or safer expression in the same file.

## error-handling
severity: error
Flag exceptions that are silently swallowed — caught and then neither logged, rethrown, nor otherwise acted on. Do not flag a catch that carries a comment explaining why the exception is intentionally ignored, or an established idiom such as restoring the interrupt flag on InterruptedException.

## input-validation
severity: error
Flag unvalidated external input only when the visible code is demonstrably the trust boundary — for example an HTTP handler that reads raw params, body, or headers and uses them directly for a lookup, persistence, a filesystem path, a command, a URL, or a security decision. Do not assume validation is missing because you cannot see the middleware or caller that may already perform it.

## authorization
severity: error
Flag a missing permission, ownership, tenant, or role check only when the visible code shows the check is expected and absent — for example sibling endpoints in the same file perform the check and the changed one does not. Never flag the mere absence of a check when enforcement may live elsewhere.

## data-integrity
severity: error
Flag changes that can corrupt, drop, duplicate, or partially persist data only when the corruption path is visible in the diff — a wrong update predicate, a non-idempotent retry, or an unsafe default on a changed line. Do not speculate about a missing transaction when the boundary may be declared in a caller or configuration you cannot see.

## boundary-conditions
severity: error
Flag empty, zero, negative, duplicate, missing, maximum, or malformed input handling only when you can name a concrete input that makes the visible code fail. The finding message must state that input.

## secret-handling
severity: error
gate: true
Never log, return, persist, or expose secrets, tokens, credentials, personal data, or internal auth headers.

## observability
severity: warning
Important failure paths should have useful logs or metrics without leaking sensitive data. Flag a silent failure path or an error message that would make the failure impossible to debug.

Do NOT flag `System.out` / `System.err` / `println` in **CLI entry-point classes** (a `main(String[] args)` method, classes whose name matches `*Application`, `*Cli`, `*Main`, or which use `System.exit`). For CLIs, stdout/stderr IS the public interface — `--help` text, error messages, status output. Flagging them as "stray logging" produces false positives. Only flag print calls outside CLI entry-point context, or print calls in CLI code that are clearly debug residue (no surrounding error/help context, conditional on debug flags, etc.).

## test-coverage
severity: warning
When behavior changes, tests should cover the changed success path and at least one relevant failure or edge case. Flag missing tests for risky changed logic.

## backward-compatibility
severity: error
Flag a breaking change only to a visibly-public contract: an exported or published API, or a serialized format with visible persistence or wire usage. An internal refactor with no visible external consumer does not count.

## missing-file-reference
severity: error
Flag changed imports, requires, dynamic imports, config references, or resource paths that point to files not present in the committed source branch — usually a new file created locally but not committed. Account for the NodeNext idiom where a `./x.js` import resolves to a sibling `.ts`/`.tsx`/`.mts` source file; do not flag those.

## typo-corrections
severity: warning
Flag clear typos in user-visible strings, identifiers introduced by the change, config keys, comments that describe behavior, and test names. Mark autoFixable true when the correction is an obvious same-file spelling fix and does not rename public API across files.

## code-duplication
severity: warning
Flag logic duplicated within the diff that should be extracted into a shared function. Do not flag duplication against code outside the changed lines, which you cannot fully see.
