---
extensions: [.c, .cc, .cpp, .cxx, .h, .hh, .hpp, .hxx]
---
# C/C++ Review Rules

## memory-lifetime
severity: error
gate: true
signals: [pointer, ownership, raw-memory]
Flag use-after-free, double-free, leaks, returning pointers/references to stack data, mismatched new/delete or malloc/free, and unclear ownership transfer.

## buffer-bounds
severity: error
gate: true
signals: [buffer, c-string, raw-memory]
Flag out-of-bounds reads/writes, missing null terminators, incorrect length calculations, sizeof(pointer) bugs, and unsafe writes into fixed-size buffers.

## null-pointer
severity: error
signals: [pointer]
Flag a possible null dereference only when the nullable source is visible: an unchecked allocation result in C, or a call to an API documented to return a nullable pointer. If you cannot see where the pointer could become null, do not flag.

## format-string
severity: error
gate: true
signals: [format-string]
Flag printf/scanf/syslog-style calls where the format string is not a literal or where arguments do not match the format specifiers.

## integer-overflow
severity: error
gate: true
signals: [numeric, allocation, buffer]
Flag arithmetic used for allocation sizes, indexing, byte counts, or protocol lengths that can overflow or wrap before validation.

## resource-management
severity: error
gate: true
signals: [resource, ownership]
Flag files, sockets, mutexes, handles, allocations, or locks that are not released on all paths. Preferring RAII over manual cleanup in C++ is non-blocking advice, not a defect on its own.

## concurrency-safety
severity: error
signals: [concurrency]
Flag data races, missing locks, non-atomic shared state, lock-order inversions, or condition-variable misuse only when the concurrent access is visible — thread creation in the diff, or shared mutable static reached from a known-threaded path. Do not flag code merely because it "could race if called concurrently."

## move-semantics
severity: warning
signals: [cpp, ownership]
Flag use-after-move, unnecessary copies of expensive objects, and broken copy/move constructors or assignment operators.

## exception-safety
severity: warning
signals: [cpp, resource]
Flag leaks or inconsistent state when constructors, destructors, allocation, or callbacks throw. Destructors must not throw.

## undefined-behavior
severity: error
gate: true
signals: [pointer, numeric, lifetime, raw-memory]
Flag undefined behavior: signed overflow, invalid casts, uninitialized reads, dangling references, and invalid iterator/reference use. A strict-aliasing violation requires type-level evidence of the aliasing in the visible code — do not assert it speculatively.

## portability
severity: warning
signals: [compiler-specific]
Flag non-portable compiler extensions, platform-specific assumptions, and headers/APIs that break supported build targets unless guarded.

## header-api-impact
severity: warning
signals: [c-cpp]
Flag C/C++ header changes that alter public declarations, struct/class layout, enum values, or function signatures without matching implementation/caller/test updates in the same MR.
