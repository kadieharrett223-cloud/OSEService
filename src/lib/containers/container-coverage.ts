import type { getSupabaseAdmin } from "@/lib/supabase/admin";
import { dedupeDemandLines, isOpenDemandLine } from "@/lib/demand/product-demand";
import { computeCoverage, totalDemandQty, type CoverageRow, type DemandByProduct, type DemandLine } from "./coverage-math";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

const IN_WAREHOUSE_STATUSES = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "PARTIALLY_FULFILLED", "FULFILLED"];

export const UNPLANNED_RECEIPT_REF = "UNPLANNED_RECEIPT";

export type ContainerLineSummary = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  expectedQty: number;
  receivedQty: number;
  isUnplanned: boolean;
  demandQty: number;
  assignedQty: number;
};

export type ContainerReceipt = {
  lifecycleStatus: string | null;
  isReceived: boolean;
  lines: ContainerLineSummary[];
  demandByProduct: DemandByProduct;
  /** Units used for coverage: actual received once the container is received, otherwise the forecast. */
  effectiveQtyByProduct: Record<string, number>;
  rows: CoverageRow[];
  eligibleLineIds: Set<string>;
};

type ContainerLineRow = {
  id: string;
  product_id: string | null;
  ordered_qty: number | null;
  on_order_qty: number | null;
  received_qty: number | null;
  source_line_ref: string | null;
  products?: { sku: string | null; canonical_name: string | null } | null;
};

type OpenOrderLineRow = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  approval_status?: string | null;
  fulfillment_status?: string | null;
  qbo_invoice_line_id?: string | null;
  source_record_id?: string | null;
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

/** Planned quantities are a forecast; only received_qty reflects physical stock. */
export function getExpectedQty(line: { ordered_qty: number | null; on_order_qty: number | null }) {
  return Math.max(0, Number(line.ordered_qty ?? 0) || Number(line.on_order_qty ?? 0));
}

export async function loadContainerReceipt(supabase: SupabaseAdmin, containerId: string): Promise<ContainerReceipt> {
  const [{ data: containerRow }, { data: containerLineRows }] = await Promise.all([
    supabase.from("containers").select("id, lifecycle_status").eq("id", containerId).maybeSingle(),
    supabase
      .from("container_lines")
      .select("id, product_id, ordered_qty, on_order_qty, received_qty, source_line_ref, products (sku, canonical_name)")
      .eq("container_id", containerId),
  ]);

  const lifecycleStatus = (containerRow as { lifecycle_status: string | null } | null)?.lifecycle_status ?? null;
  const isReceived = String(lifecycleStatus ?? "").toUpperCase() === "RECEIVED";
  const containerLines = ((containerLineRows ?? []) as unknown as ContainerLineRow[]).filter((line) => Boolean(line.product_id));

  const productIds = Array.from(new Set(containerLines.map((line) => line.product_id as string)));

  const [{ data: allocationRows }, { data: openLineRows }] = await Promise.all([
    supabase
      .from("inventory_allocations")
      .select("shipping_order_line_id")
      .eq("container_id", containerId)
      .eq("source_type", "CONTAINER")
      .eq("allocation_status", "ALLOCATED"),
    productIds.length
      ? supabase
          .from("shipping_order_lines")
          .select(`
            id,
            product_id,
            approved_qty,
            fulfilled_qty,
            approval_status,
            fulfillment_status,
            qbo_invoice_line_id,
            source_record_id,
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
          .neq("fulfillment_status", "FULFILLED")
      : Promise.resolve({ data: [] }),
  ]);

  const assignedLineIds = new Set(
    (allocationRows ?? [])
      .map((row) => (row as { shipping_order_line_id: string | null }).shipping_order_line_id)
      .filter((value): value is string => Boolean(value)),
  );

  const demandByProduct: DemandByProduct = {};
  for (const productId of productIds) demandByProduct[productId] = [];

  for (const line of dedupeDemandLines((openLineRows ?? []) as unknown as OpenOrderLineRow[])) {
    if (!line.product_id || !demandByProduct[line.product_id]) continue;
    if (IN_WAREHOUSE_STATUSES.includes(line.warehouse_status ?? "")) continue;
    if (!isOpenDemandLine(line)) continue;

    const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    if (remainingQty <= 0) continue;

    const order = line.shipping_orders;
    demandByProduct[line.product_id].push({
      lineId: line.id,
      orderId: order?.id ?? "",
      productId: line.product_id,
      invoice: order?.qbo_invoices?.invoice_number ?? order?.order_number ?? "—",
      customer:
        order?.customers?.company_name ?? order?.customers?.full_name ?? order?.legacy_customer_name ?? "Customer pending",
      sku: line.products?.sku ?? line.products?.canonical_name ?? "SKU pending",
      remainingQty,
      queuePosition: line.queue_position_start ?? null,
      currentWarehouse: formatStatus(line.warehouse_status),
      isAssigned: assignedLineIds.has(line.id),
      createdAt: line.created_at,
    } satisfies DemandLine);
  }

  const effectiveQtyByProduct: Record<string, number> = {};
  const lines: ContainerLineSummary[] = containerLines.map((line) => {
    const productId = line.product_id as string;
    const expectedQty = getExpectedQty(line);
    const receivedQty = Math.max(0, Number(line.received_qty ?? 0));
    const demandQty = totalDemandQty(demandByProduct[productId] ?? []);

    // Once received, physical counts are authoritative even when nothing arrived.
    const effectiveQty = isReceived ? receivedQty : expectedQty;
    effectiveQtyByProduct[productId] = (effectiveQtyByProduct[productId] ?? 0) + effectiveQty;

    return {
      id: line.id,
      productId,
      sku: line.products?.sku ?? "SKU pending",
      productName: line.products?.canonical_name ?? line.products?.sku ?? "Product",
      expectedQty,
      receivedQty,
      isUnplanned: line.source_line_ref === UNPLANNED_RECEIPT_REF,
      demandQty,
      assignedQty: Math.min(demandQty, expectedQty),
    };
  });

  const { rows, eligibleLineIds } = computeCoverage(demandByProduct, effectiveQtyByProduct);

  return { lifecycleStatus, isReceived, lines, demandByProduct, effectiveQtyByProduct, rows, eligibleLineIds };
}
