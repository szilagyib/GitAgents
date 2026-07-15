import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../src/concurrency";

describe("mapWithConcurrency", () => {
  it("never runs more than `limit` tasks in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBe(4);
  });

  it("preserves input order in the results", async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, (5 - n) * 2));
      return n * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      seen.push(n);
    });

    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("handles an empty input without invoking fn", async () => {
    let called = false;
    const results = await mapWithConcurrency([], 4, async () => {
      called = true;
    });

    expect(results).toEqual([]);
    expect(called).toBe(false);
  });
});
