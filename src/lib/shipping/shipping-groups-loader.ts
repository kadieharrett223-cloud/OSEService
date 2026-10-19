import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { loadCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-loader";
import { fetchQueuePages } from "@/lib/demand/queue-query-pages";
import {
  customerQueueObligationQty,
  isOpenCustomerQueueLine,
} from "@/lib/demand/product-demand";
import { inventoryOperationalIdentity } from "@/lib/inventory/stock-edit-context";
import {
  authoritativeStockProductIds,
  canonicalSkuKey,
} from "@/lib/products/canonical-sku";
import { getCachedOldErpProductIdentityBySourceRecordId } from "@/lib/products/old-erp-product-identity";
import {
  resolveProductCoverage,
  validateProductCoverage,
  type OpenQueueLine,
  type ProductContainerSupply,
} from "@/lib/fulfillment/suggested-allocation";
import {
  getPackageDimensions,
  formatPackageDimensions,
  formatPackageWeight,
} from "@/lib/products/package-dimensions";
import {
  invoiceDeliveryAddress,
  type ShippingCandidate,
} from "./shipping-groups";
import coordinates from "./zcta-2025.json";

type Product = {
  id: string;
  sku: string;
  canonical_name: string;
  source_record_id: string | null;
  inventory_group: string | null;
};
type Transaction = { product_id: string; delta: number; source_type: string };
type ContainerLine = {
  product_id: string;
  container_id: string;
  on_order_qty: number;
  received_qty: number;
  containers: {
    container_number: string;
    lifecycle_status: string;
    eta_confirmed_date: string | null;
    eta_estimated_date: string | null;
    entered_date: string | null;
  } | null;
};
type Order = {
  id: string;
  payment_hold: boolean;
  delivery_address: unknown;
  qbo_invoices: {
    raw_payload: {
      PrivateNote?: string;
      CustomerMemo?: { value?: string };
    } | null;
  } | null;
};
type Alias = { product_id: string; alias: string };
type Source = {
  source_record_id: string;
  raw_payload: Record<string, unknown>;
};
const points = coordinates as unknown as Record<string, [number, number]>;
async function read<T>(
  query: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>,
) {
  return (await fetchQueuePages(query, 2)) as T[];
}

/** SELECT-only planning model. It never calls sync, allocates, ships or writes stock. */
export async function loadShippingGroupCandidates() {
  const db = getSupabaseAdmin();
  const [
    queue,
    products,
    aliases,
    transactions,
    containerLines,
    archive,
    sources,
  ] = await Promise.all([
    loadCanonicalCustomerQueue(),
    read<Product>((a, b) =>
      db
        .from("products")
        .select("id,sku,canonical_name,source_record_id,inventory_group")
        .neq("status", "Inactive")
        .order("id")
        .range(a, b),
    ),
    read<Alias>((a, b) =>
      db
        .from("product_aliases")
        .select("id,product_id,alias")
        .order("id")
        .range(a, b),
    ),
    read<Transaction>((a, b) =>
      db
        .from("inventory_transactions")
        .select("id,product_id,delta,source_type")
        .eq("bucket", "ON_FLOOR")
        .order("id")
        .range(a, b),
    ),
    read<ContainerLine>((a, b) =>
      db
        .from("container_lines")
        .select(
          "id,product_id,container_id,on_order_qty,received_qty,containers(container_number,lifecycle_status,eta_confirmed_date,eta_estimated_date,entered_date)",
        )
        .order("id")
        .range(a, b),
    ),
    getCachedOldErpProductIdentityBySourceRecordId(),
    read<Source>((a, b) =>
      db
        .from("old_erp_source_records")
        .select("id,source_record_id,raw_payload")
        .eq("source_container", "Products")
        .order("id")
        .range(a, b),
    ),
  ]);
  const lines = queue.canonicalLines.filter(
    (l) => isOpenCustomerQueueLine(l) && queue.queueByLineId.has(l.id),
  );
  const { operationalSkuByProduct } = inventoryOperationalIdentity(
    products,
    aliases,
    archive,
    lines,
  );
  const keys = new Map(
    products.map((p) => [
      p.id,
      canonicalSkuKey(operationalSkuByProduct.get(p.id) ?? p.sku),
    ]),
  );
  const ownerIds = authoritativeStockProductIds(
    products,
    keys,
    new Set(transactions.map((t) => t.product_id)),
    new Set(
      transactions
        .filter((t) =>
          ["ADJUSTMENT", "RECOUNT", "CONTAINER_RECEIVED"].includes(
            t.source_type,
          ),
        )
        .map((t) => t.product_id),
    ),
  );
  const floor = new Map<string, number>();
  for (const t of transactions)
    if (ownerIds.has(t.product_id)) {
      const key = keys.get(t.product_id);
      if (key) floor.set(key, (floor.get(key) ?? 0) + Number(t.delta));
    }
  const demand = new Map<string, OpenQueueLine[]>();
  for (const l of lines) {
    const key = keys.get(l.product_id ?? "");
    if (!key) continue;
    const remaining = Math.max(
      0,
      customerQueueObligationQty(l) - Number(l.fulfilled_qty ?? 0),
    );
    const allocations = (l.inventory_allocations ?? []).filter(
      (a) => (a.allocation_status ?? "ALLOCATED") === "ALLOCATED",
    );
    const pinned = allocations
      .filter((a) => a.source_type === "FLOOR")
      .reduce((s, a) => s + Number(a.quantity ?? 0), 0);
    const row: OpenQueueLine = {
      id: l.id,
      product_id: key,
      remaining_qty: remaining,
      priority: l.priority ?? null,
      queue_position_start:
        Number.parseInt(queue.queueByLineId.get(l.id)?.position ?? "") || null,
      approved_at: null,
      created_at: l.shipping_orders?.created_at ?? "",
      has_live_allocation: allocations.length > 0,
      fulfillment_source: l.fulfillment_source,
      warehouse_reserved_qty: Math.max(
        pinned,
        ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(
          l.warehouse_status ?? "",
        )
          ? remaining
          : 0,
      ),
      container_reserved_quantities: allocations
        .filter((a) => a.source_type === "CONTAINER" && a.container_id)
        .map((a) => ({
          container_id: a.container_id!,
          quantity: Number(a.quantity ?? 0),
        })),
    };
    demand.set(key, [...(demand.get(key) ?? []), row]);
  }
  const supplies = new Map<string, ProductContainerSupply[]>();
  const byContainer = new Map<string, ProductContainerSupply>();
  for (const c of containerLines) {
    const key = keys.get(c.product_id),
      container = c.containers;
    if (
      !key ||
      !container ||
      !["ORDERED", "PRODUCTION", "INBOUND"].includes(
        String(container.lifecycle_status ?? "").toUpperCase(),
      )
    )
      continue;
    const qty = Math.max(0, Number(c.on_order_qty) - Number(c.received_qty));
    const id = key + "|" + c.container_id,
      previous = byContainer.get(id);
    if (previous)
      previous.available_qty = Math.max(previous.available_qty, qty);
    else
      byContainer.set(id, {
        container_id: c.container_id,
        container_number: container.container_number,
        available_qty: qty,
        eta_confirmed_date: container.eta_confirmed_date,
        eta_estimated_date: container.eta_estimated_date,
        entered_date: container.entered_date,
      });
  }
  for (const [id, c] of byContainer) {
    const key = id.split("|")[0];
    supplies.set(key, [...(supplies.get(key) ?? []), c]);
  }
  const warehouseQty = new Map<string, number>();
  const warnings: string[] = [];
  const liftKeys = new Set(products
    .filter(p => p.inventory_group?.toLowerCase().includes("lifts"))
    .map(p => keys.get(p.id)));
  for (const key of demand.keys()) {
    if (!liftKeys.has(key)) continue;
    const resolution = resolveProductCoverage(key, {
      floorAvailableByProduct: floor,
      queueLinesByProduct: demand,
      containerSupplyByProduct: supplies,
    });
    if (
      validateProductCoverage(resolution).some((d) => d.severity === "ERROR")
    ) {
      warnings.push(
        `${key}: allocation/supply conflict; excluded until reviewed.`,
      );
      continue;
    }
    for (const [id, c] of resolution.lines)
      warehouseQty.set(id, c.warehouseQty);
  }
  const orderIds = [
    ...new Set(
      lines
        .map((l) => l.shipping_orders?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const orders: Order[] = [];
  const notesByOrder = new Map<string, string[]>();
  for (let i = 0; i < orderIds.length; i += 100) {
    const result = await db
      .from("shipping_orders")
      .select("id,payment_hold,delivery_address,qbo_invoices(raw_payload)")
      .in("id", orderIds.slice(i, i + 100));
    if (result.error) throw new Error(result.error.message);
    orders.push(...(result.data as unknown as Order[]));
    const notes = await read<{
      entity_id: string;
      details: { message?: string };
    }>((a, b) =>
      db
        .from("audit_log")
        .select("id,entity_id,details")
        .eq("action", "ORDER_NOTE_ADDED")
        .in("entity_id", orderIds.slice(i, i + 100))
        .order("id")
        .range(a, b),
    );
    for (const note of notes)
      if (note.details?.message)
        notesByOrder.set(note.entity_id, [
          ...(notesByOrder.get(note.entity_id) ?? []),
          note.details.message,
        ]);
  }
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const productById = new Map(products.map((p) => [p.id, p]));
  const sourceById = new Map(
    sources.map((s) => [s.source_record_id, s.raw_payload]),
  );
  const candidates = new Map<string, ShippingCandidate>();
  let excludedLifts = 0;
  for (const l of lines) {
    const p = productById.get(l.product_id ?? ""),
      parent = l.shipping_orders;
    if (!p || !parent || !p.inventory_group?.toLowerCase().includes("lifts"))
      continue;
    const o = orderById.get(parent.id),
      qty = warehouseQty.get(l.id) ?? 0;
    if (
      qty <= 0 ||
      !o ||
      o.payment_hold ||
      parent.fulfillment_method === "WILL_CALL"
    ) {
      excludedLifts++;
      continue;
    }
    const q = queue.queueByLineId.get(l.id)!;
    const raw = o.qbo_invoices?.raw_payload;
    const parsed = invoiceDeliveryAddress(o.delivery_address);
    const point = parsed.address ? (points[parsed.address.zip] ?? null) : null;
    const instructions = [
      raw?.CustomerMemo?.value,
      raw?.PrivateNote,
      ...(notesByOrder.get(parent.id) ?? []),
    ]
      .filter(Boolean)
      .join("\n");
    const candidate = candidates.get(parent.id) ?? {
      orderId: parent.id,
      invoice: q.invoice,
      customer:
        parent.qbo_invoices?.customers?.company_name ??
        parent.qbo_invoices?.customers?.full_name ??
        parent.legacy_customer_name ??
        "Customer",
      priorityDate: q.priorityDate,
      orderDate: q.invoiceDate ?? q.orderCreatedAt,
      address: parsed.address,
      addressIssue:
        parsed.issue ??
        (!point
          ? "ZIP is not in Census ZCTA data; manual geographic review required."
          : null),
      point,
      lifts: [],
      instructions,
    };
    const key = keys.get(p.id)!;
    const sourceProduct = products.find(
      (other) =>
        keys.get(other.id) === key &&
        other.source_record_id &&
        sourceById.has(other.source_record_id),
    );
    const dimensions = getPackageDimensions(
      sourceById.get(sourceProduct?.source_record_id ?? ""),
    );
    candidate.lifts.push({
      sku: operationalSkuByProduct.get(p.id) ?? p.sku,
      quantity: qty,
      queuePosition: q.position,
      packageLabel: dimensions
        ? `${formatPackageDimensions(dimensions) ?? "Dimensions missing"} · ${formatPackageWeight(dimensions) ?? "Weight missing"}`
        : "Packed dimensions/weight missing",
      unitWeight: dimensions?.weightPounds ?? null,
    });
    candidate.instructions = instructions || candidate.instructions;
    candidates.set(parent.id, candidate);
  }
  return {
    candidates: [...candidates.values()],
    warnings,
    excludedLifts,
    checkedAt: new Date().toISOString(),
  };
}
