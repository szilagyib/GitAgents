import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveFixMode, suggestionMarker } from "../src/cli.js";

describe("resolveFixMode", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts the three known modes", () => {
    expect(resolveFixMode("suggest")).toBe("suggest");
    expect(resolveFixMode("push")).toBe("push");
    expect(resolveFixMode("off")).toBe("off");
  });

  it("defaults to suggest when unset", () => {
    expect(resolveFixMode("")).toBe("suggest");
  });

  it("warns and falls back to suggest on an unknown value", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveFixMode("yolo")).toBe("suggest");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"yolo"'));
  });
});

describe("suggestionMarker", () => {
  it("round-trips through the dedup scan pattern", () => {
    const marker = suggestionMarker("abc123DEF");
    const re = /<!--\s*gitagents:suggestion:([A-Za-z0-9]+)\s*-->/g;
    const found = [...`some text\n${marker}\nmore`.matchAll(re)].map((m) => m[1]);
    expect(found).toEqual(["abc123DEF"]);
  });
});
