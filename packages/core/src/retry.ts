export interface RetryOptions {
  shouldRetry: (err: unknown, attempt: number) => boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !opts.shouldRetry(err, attempt)) {
        throw err;
      }
      await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}
