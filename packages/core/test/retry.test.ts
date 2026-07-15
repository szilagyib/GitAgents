import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/retry";

describe("withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { shouldRetry: () => true });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors and returns the eventual success", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error("transient"));
      return Promise.resolve("ok");
    });

    const result = await withRetry(fn, {
      shouldRetry: () => true,
      baseDelayMs: 0,
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("propagates the error after maxAttempts attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(
      withRetry(fn, {
        shouldRetry: () => true,
        baseDelayMs: 0,
        maxAttempts: 3,
      })
    ).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));

    await expect(
      withRetry(fn, {
        shouldRetry: () => false,
        baseDelayMs: 0,
      })
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff via the injected sleep function", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const fn = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error("retry"));
      return Promise.resolve("ok");
    });

    await withRetry(fn, {
      shouldRetry: () => true,
      baseDelayMs: 100,
      sleep,
    });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });
});
