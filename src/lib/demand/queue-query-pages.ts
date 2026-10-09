type PageResult<T> = { data: T[] | null; error: { message: string; code?: string } | null };

/** Smaller joined-query pages, with one retry of the SAME timed-out page.
 * Callers must order by a unique key. Never return a partial list or
 * substitute stale demand after a read failure.
 */
export async function fetchQueuePages<T>(fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>, concurrency = 1) {
  const pageSize = 100;
  const width = Math.max(1, Math.min(4, Math.floor(concurrency) || 1));
  const rows: T[] = [];
  async function readPage(from: number) {
    let result = await fetchPage(from, from + pageSize - 1);
    if (result.error?.code === "57014" || result.error?.message.includes("statement timeout")) {
      result = await fetchPage(from, from + pageSize - 1);
    }
    if (result.error) throw new Error(result.error.message);
    return result.data ?? [];
  }
  // Keep the first read singular: small tables need no speculative requests.
  const first = await readPage(0);
  rows.push(...first);
  if (first.length < pageSize) return rows;
  for (let from = pageSize; ; from += pageSize * width) {
    const pages = await Promise.all(Array.from({ length: width }, (_, index) => readPage(from + index * pageSize)));
    // Promise.all preserves offset order, regardless of completion order.
    // A failed page rejects the entire read, never publishing partial demand.
    for (const page of pages) {
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }
}

/** Per-projection limit, shared by every table and ID batch. No cache or writes. */
export function createQueueReadPool(limit = 4) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function read<T>(query: () => PromiseLike<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await query();
    } finally {
      const next = waiting.shift();
      if (next) next(); // Transfer this slot directly to the next query.
      else active -= 1;
    }
  };
}
