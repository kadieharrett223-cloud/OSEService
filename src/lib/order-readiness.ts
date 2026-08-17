export type ReadyQueueLine = {
  id: string;
  remaining_qty: number;
  priority?: string | null;
  queue_position_start?: number | null;
  approved_at?: string | null;
  created_at?: string | null;
  has_live_allocation?: boolean;
};

const PRIORITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

function normalizePriority(priority: string | null | undefined) {
  return PRIORITY_RANK[String(priority ?? "NORMAL").trim().toUpperCase()] ?? PRIORITY_RANK.NORMAL;
}

function sortByQueuePriority(left: ReadyQueueLine, right: ReadyQueueLine) {
  const priorityDifference = normalizePriority(left.priority) - normalizePriority(right.priority);
  if (priorityDifference !== 0) return priorityDifference;

  const leftQueue = Number.isFinite(left.queue_position_start) ? Number(left.queue_position_start) : Number.MAX_SAFE_INTEGER;
  const rightQueue = Number.isFinite(right.queue_position_start) ? Number(right.queue_position_start) : Number.MAX_SAFE_INTEGER;
  if (leftQueue !== rightQueue) return leftQueue - rightQueue;

  const leftApproved = left.approved_at ? new Date(left.approved_at).getTime() : Number.MAX_SAFE_INTEGER;
  const rightApproved = right.approved_at ? new Date(right.approved_at).getTime() : Number.MAX_SAFE_INTEGER;
  if (leftApproved !== rightApproved) return leftApproved - rightApproved;

  const leftCreated = left.created_at ? new Date(left.created_at).getTime() : Number.MAX_SAFE_INTEGER;
  const rightCreated = right.created_at ? new Date(right.created_at).getTime() : Number.MAX_SAFE_INTEGER;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;

  return left.id.localeCompare(right.id);
}

export function getReadyToShipLineIds(
  lines: ReadyQueueLine[],
  availableUnits: number,
): string[] {
  const normalizedAvailable = Math.max(0, Number(availableUnits) || 0);
  if (normalizedAvailable <= 0) return [];

  let remaining = normalizedAvailable;
  const readyIds = new Set<string>();

  for (const line of [...lines].sort(sortByQueuePriority)) {
    const needed = Math.max(0, Number(line.remaining_qty ?? 0));
    if (needed <= 0 || line.has_live_allocation) continue;
    if (remaining <= 0) break;
    if (remaining < needed) break;

    readyIds.add(line.id);
    remaining -= needed;
  }

  return Array.from(readyIds);
}
