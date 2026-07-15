---
extensions: [.java]
---
# Java Review Rules

## naming-conventions
severity: warning
Classes: PascalCase. Methods/variables: camelCase. Constants: UPPER_SNAKE_CASE. No Hungarian notation.

## optional-usage
severity: error
Concerns java.util.Optional<T> specifically. Flag `.get()` on a confirmed Optional receiver with no preceding `.isPresent()` check and no `.orElse(...)`.

**Before flagging a .get() call, verify the receiver type is java.util.Optional.** Do NOT flag:
- JavaFX `Property.get()` (StringProperty, BooleanProperty, IntegerProperty, ObservableValue, etc.) — these are accessor methods returning the stored value, not Optional unwrappers.
- `Map.get()`, `List.get()`, `AtomicReference.get()`, `WeakReference.get()`, `ThreadLocal.get()`, `Future.get()`, `Supplier.get()`, custom getters named `get()`.

If you cannot determine the receiver type from the diff or surrounding code, set `confidence: low` and skip rather than flag.

Returning null instead of an Optional<T> is non-blocking style advice, not a defect on its own.

## resource-management
severity: error
Flag closeable resources that can leak because they are not closed on some path; prefer try-with-resources. A manual `close()` in a `finally` block is a valid idiom, not a defect.

## transaction-boundaries
severity: error
signals: [spring, jpa, database-write]
Flag a multi-step write that lacks a transaction only when the missing boundary is visible in the diff. Do not speculate about `@Transactional`, AOP, or a rollback strategy declared in a caller, base class, or configuration you cannot see.

## spring-security
severity: error
profiles: [spring-web]
signals: [spring]
For Spring code, flag missing authorization, trust in request-supplied user IDs, or unexplained disabled CSRF only when the visible code shows the gap — for example an endpoint whose siblings in the same file enforce a check that this one omits. Do not assume security is absent because it may be applied by a filter chain, AOP, or configuration you cannot see.

## jpa-lazy-loading
severity: warning
signals: [jpa]
Flag lazy-loaded entity access outside a transaction, N+1 query patterns in loops, or returning mutable JPA entities directly from APIs only when the pattern is visible in the diff. Do not assume a fetch or transaction boundary is missing when it may be declared elsewhere.

## java-time
severity: warning
signals: [date-time]
Prefer java.time types. Flag Date/Calendar misuse, system-default timezone assumptions, and date comparisons that ignore timezone/precision.

## numeric-precision
severity: error
signals: [numeric]
Flag double/float arithmetic for money only when identifiers or context clearly indicate currency (price, amount, total, balance, cost, tax, or a rate applied to a monetary value); use BigDecimal there. Do not flag floating-point math whose domain is not evidently monetary.

## equals-hashcode-contract
severity: error
gate: true
Classes that override equals() must also override hashCode(), and vice versa.

## string-comparison
severity: error
gate: true
String equality must use .equals(), not == or !=.

## enum-comparison
severity: error
Flag `valueOf` on external input without validation, and enum-to-value conversions that silently drop unknown values. A switch that intentionally handles every current enum constant is not a defect — do not demand a default clause for an exhaustive switch.

## collection-api-misuse
severity: warning
signals: [collection]
Flag anti-patterns like keySet() + get() instead of entrySet(), contains() before add() on a Set.

## stream-api-misuse
severity: warning
signals: [stream]
No stateful lambdas in Stream operations. No side effects in map()/filter().

## serialization-safety
severity: warning
signals: [serialization]
Serializable classes must declare serialVersionUID. Non-serializable fields must be transient.
