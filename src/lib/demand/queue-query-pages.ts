type PageResult<T> = { data: T[] | null; error: { message: string; code?: string } | null };

/** Smaller joined-query pages, with one retry of the SAME timed-out page.
 * Callers must order by a unique key. Never return a partial list or
 * substitute stale demand after a read failure.
 */
export async function fetchQueuePages<T>(fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>) {
  const pageSize = 100;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    let result = await fetchPage(from, from + pageSize - 1);
    if (result.error?.code === "57014" || result.error?.message.includes("statement timeout")) {
      result = await fetchPage(from, from + pageSize - 1);
    }
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
    if ((result.data ?? []).length < pageSize) return rows;
  }
}
