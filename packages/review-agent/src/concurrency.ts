/**
 * Run `fn` over `items` with at most `limit` invocations in flight at once.
 *
 * Preserves input order in the returned array. Used to cap the number of
 * concurrent Claude calls per review run — an unbounded `Promise.all` fires
 * every request simultaneously and drives the API into 429s.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= items.length) return;
          results[index] = await fn(items[index], index);
        }
      })()
    );
  }

  await Promise.all(workers);
  return results;
}
