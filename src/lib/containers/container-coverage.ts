import type { getSupabaseAdmin } from "@/lib/supabase/admin";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

const IN_WAREHOUSE_STATUSES = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "PARTIALLY_FULFILLED", "FULFILLED"];

export type ContainerCoverageRow = {
  lineId: string;
  orderId: string;
  productId: string;
  invoice: string;
  customer: string;
  sku: string;
  remainingQty: number;
  coveredQty: number;
  queuePosition: number | null;
  currentWarehouse: string;
  isAssigned: boolean;
  willMarkInWarehouse: boolean;
};

export type ContainerCoverage = {
  hasExplicitReceipts: boolean;
  incomingByProduct: Map<string, number>;
  rows: ContainerCoverageRow[];
  eligibleLineIds: Set<string>;
};

type ContainerLineRow = {
  product_id: string | null;
  ordered_qty: number | null;
  on_order_qty: number | null;
  received_qty: number | null;
};

type OpenOrderLineRow = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  warehouse_status: string | null;
  queue_position_start: number | null;
  created_at: string;
  products?: { sku: string | null; canonical_name: string | null } | null;
  shipping_orders?: {
    id: string;
    order_number: string | null;
    legacy_customer_name: string | null;
    customers?: { company_name: string | null; full_name: string | null } | null;
    qbo_invoices?: { invoice_number: string | null } | null;
  } | null;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getIncomingQty(line: ContainerLineRow, hasExplicitReceipts: boolean) {
  if (hasExplicitReceipts) return Math.max(0, Number(line.received_qty ?? 0));
  return Math.max(0, Number(line.ordered_qty ?? 0) || Number(line.on_order_qty ?? 0));
}

/**
 * Container units are matched to customer demand by product queue order, so a container shows the
 * customers waiting on it even when no explicit allocation row was ever created.
 */
export async function loadContainerCoverage(supabase: SupabaseAdmin, containerId: string): Promise<ContainerCoverage> {
  const { data: containerLineRows } = await supabase
    .from("container_lines")
    .select("product_id, ordered_qty, on_order_qty, received_qty")
    .eq("container_id", containerId);

  const containerLines = (containerLineRows ?? []) as ContainerLineRow[];
  const hasExplicitReceipts = containerLines.some((line) => Number(line.received_qty ?? 0) > 0);

  const incomingByProduct = new Map<string, number>();
  for (const line of containerLines) {
    if (!line.product_id) continue;
    const incoming = getIncomingQty(line, hasExplicitReceipts);
    if (incoming <= 0) continue;
    incomingByProduct.set(line.product_id, (incomingByProduct.get(line.product_id) ?? 0) + incoming);
  }

  const productIds = Array.from(incomingByProduct.keys());
  if (productIds.length === 0) {
    return { hasExplicitReceipts, incomingByProduct, rows: [], eligibleLineIds: new Set() };
  }

  const [{ data: allocationRows }, { data: openLineRows }] = await Promise.all([
    supabase
      .from("inventory_allocations")
      .select("shipping_order_line_id, quantity")
      .eq("container_id", containerId)
      .eq("source_type", "CONTAINER")
      .eq("allocation_status", "ALLOCATED"),
    supabase
      .from("shipping_order_lines")
      .select(`
        id,
        product_id,
        approved_qty,
        fulfilled_qty,
        warehouse_status,
        queue_position_start,
        created_at,
        products (sku, canonical_name),
        shipping_orders (
          id,
          order_number,
          legacy_customer_name,
          customers (company_name, full_name),
          qbo_invoices (invoice_number)
        )
      `)
      .in("product_id", productIds)
      .eq("approval_status", "APPROVED")
      .neq("fulfillment_status", "FULFILLED"),
  ]);

  const assignedLineIds = new Set(
    (allocationRows ?? [])
      .map((row) => (row as { shipping_order_line_id: string | null }).shipping_order_line_id)
      .filter((value): value is string => Boolean(value)),
  );

  const candidates = ((openLineRows ?? []) as unknown as OpenOrderLineRow[])
    .filter((line) => Boolean(line.product_id))
    .filter((line) => !IN_WAREHOUSE_STATUSES.includes(line.warehouse_status ?? ""))
    .map((line) => {
      const order = line.shipping_orders;
      const customer = order?.customers?.company_name
        ?? order?.customers?.full_name
        ?? order?.legacy_customer_name
        ?? "Customer pending";

      return {
        lineId: line.id,
        orderId: order?.id ?? "",
        productId: line.product_id as string,
        invoice: order?.qbo_invoices?.invoice_number ?? order?.order_number ?? "—",
        customer,
        sku: line.products?.sku ?? line.products?.canonical_name ?? "SKU pending",
        remainingQty: Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)),
        coveredQty: 0,
        queuePosition: line.queue_position_start ?? null,
        currentWarehouse: formatStatus(line.warehouse_status),
        isAssigned: assignedLineIds.has(line.id),
        willMarkInWarehouse: false,
        createdAt: line.created_at,
      };
    })
    .filter((row) => row.remainingQty > 0);

  const byProduct = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const rows = byProduct.get(row.productId) ?? [];
    rows.push(row);
    byProduct.set(row.productId, rows);
  }

  const eligibleLineIds = new Set<string>();
  const rows: ContainerCoverageRow[] = [];

  for (const [productId, productRows] of byProduct.entries()) {
    // Explicitly assigned lines claim container units first, then remaining demand in queue order.
    const sorted = [...productRows].sort((left, right) => {
      if (left.isAssigned !== right.isAssigned) return left.isAssigned ? -1 : 1;
      const leftQueue = left.queuePosition ?? Number.MAX_SAFE_INTEGER;
      const rightQueue = right.queuePosition ?? Number.MAX_SAFE_INTEGER;
      if (leftQueue !== rightQueue) return leftQueue - rightQueue;
      return left.createdAt.localeCompare(right.createdAt);
    });

    let capacity = incomingByProduct.get(productId) ?? 0;
    for (const row of sorted) {
      const covered = Math.min(row.remainingQty, Math.max(0, capacity));
      capacity -= covered;
      const fullyCovered = covered > 0 && covered === row.remainingQty;
      if (fullyCovered) eligibleLineIds.add(row.lineId);

      const { createdAt: _createdAt, ...rest } = row;
      void _createdAt;
      rows.push({ ...rest, coveredQty: covered, willMarkInWarehouse: fullyCovered });
    }
  }

  rows.sort((left, right) => {
    if (left.coveredQty > 0 !== right.coveredQty > 0) return left.coveredQty > 0 ? -1 : 1;
    if (left.isAssigned !== right.isAssigned) return left.isAssigned ? -1 : 1;
    const leftQueue = left.queuePosition ?? Number.MAX_SAFE_INTEGER;
    const rightQueue = right.queuePosition ?? Number.MAX_SAFE_INTEGER;
    if (leftQueue !== rightQueue) return leftQueue - rightQueue;
    return left.customer.localeCompare(right.customer);
  });

  return { hasExplicitReceipts, incomingByProduct, rows, eligibleLineIds };
}
