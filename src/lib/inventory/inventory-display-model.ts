import { lineSourceReservations } from "@/lib/fulfillment/line-source-reservations";
import { formatCalendarDate } from "@/lib/containers/calendar-date";
import { inventoryCoverageSource } from "@/lib/orders/other-source-safety";
import { getCommittedFloor } from "@/lib/inventory/floor-demand";
import { unstable_cache } from "next/cache";
import { projectCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue";
import { loadCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-loader";
import { INVENTORY_READ_MODEL_CACHE_TAG } from "@/lib/inventory/inventory-read-cache";
import { mergeOpenCustomerDemand } from "@/lib/demand/customer-list-demand";
import { customerQueueObligationQty, demandLineIdentity, isOpenCustomerQueueLine } from "@/lib/demand/product-demand";
import { getWarehouseDemandDisplay } from "@/lib/demand/display-status";
import { resolveProductCoverage, type LineCoverage, type OpenQueueLine, type ProductContainerSupply } from "@/lib/fulfillment/suggested-allocation";
import { getAfterIncomingInventory } from "@/lib/inventory/after-incoming";
import { getBackorderedNow } from "@/lib/inventory/backordered-now";
import { qboSkuCandidates } from "@/lib/orders/quickbooks-refresh";
import { getCachedPackageDimensionsBySku } from "@/lib/products/package-dimensions-data";
import { type PackageDimensions } from "@/lib/products/package-dimensions";
import { authoritativeStockProductIds, canonicalSkuKey } from "@/lib/products/canonical-sku";
import { inventoryOperationalIdentity } from "@/lib/inventory/stock-edit-context";
import { splitProductTitle } from "@/lib/product-title";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchQueuePages } from "@/lib/demand/queue-query-pages";
import { loadInventoryStockHistory } from "@/lib/inventory/stock-history-read";

type ProductRow = {
  id: string;
  sku: string | null;
  canonical_name: string | null;
  source_record_id?: string | null;
  inventory_group?: string | null;
  inventory_sort_order?: number | null;
};

type OldErpProductSourceRow = {
  source_record_id: string | null;
  raw_payload?: {
    itemCode?: string | null;
    sku?: string | null;
    qbMatchText?: string | null;
  } | null;
};

function isOperationalInventoryProduct(product: ProductRow) {
  return product.sku?.trim().toUpperCase() !== "TEST";
}

type InventoryTransactionRow = {
  product_id: string | null;
  bucket: string | null;
  delta: number | null;
  source_type: string | null;
};

type ContainerLineRow = {
  product_id: string | null;
  on_order_qty: number | null;
  received_qty: number | null;
  container_id: string | null;
  containers?: {
    container_number: string | null;
    lifecycle_status: string | null;
    eta_confirmed_date: string | null;
    eta_estimated_date: string | null;
    port_date: string | null;
    entered_date: string | null;
  } | null;
};

type ProductAliasRow = {
  product_id: string | null;
  alias: string | null;
};

type QueueLine = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  ordered_qty?: number | null;
  fulfilled_qty: number | null;
  approval_status: string | null;
  fulfillment_status: string | null;
  priority: string | null;
  warehouse_status: string | null;
  fulfillment_source?: string | null;
  queue_position_start: number | null;
  queue_position_count: number | null;
  source_system?: string | null;
  legacy_item_code?: string | null;
  qbo_invoice_line_id?: string | null;
  source_record_id?: string | null;
  logical_demand_key?: string | null;
  shipping_orders?: {
    id: string;
    source_invoice_id?: string | null;
    source_type?: string | null;
    order_number?: string | null;
    duplicate_of_order_id?: string | null;
    cancellation_status?: string | null;
    review_status?: string | null;
    created_at?: string | null;
    first_payment_at?: string | null;
    legacy_customer_name: string | null;
    fulfillment_method?: "SHIP" | "WILL_CALL" | null;
    qbo_invoices?: {
      invoice_number: string | null;
      raw_payload?: { PrivateNote?: string | null; Line?: unknown[] } | null;
      customers?: {
        company_name: string | null;
        full_name: string | null;
      } | null;
    } | null;
  } | null;
  inventory_allocations?: Array<{
    source_type: string | null;
    container_id: string | null;
    quantity: number | null;
    allocation_status: string | null;
    containers?: {
      container_number: string | null;
      lifecycle_status: string | null;
      eta_confirmed_date: string | null;
      eta_estimated_date: string | null;
    } | null;
  }>;
  products?: { sku: string | null } | null;
};

type InventoryViewRow = {
  productId: string;
  stockProductIds: string[];
  productIds: string[];
  sku: string;
  productName: string;
  storedName: string;
  manufacturer: string | null;
  group: string;
  groupSort: number;
  sortOrder: number;
  onFloor: number;
  openDemand: number;
  floorCommitted: number;
  availableNow: number;
  backorderedNow: number;
  incoming: number;
  availableAfterIncoming: number;
  backorderedAfterIncoming: number;
  nextEta: string;
  packageDimensions: PackageDimensions | null;
  incomingContainers: Array<{
    containerNumber: string;
    qty: number;
    committed: number;
    available: number;
    eta: string;
    etaSort: string;
    status: string;
  }>;
  customerQueue: Array<{
    position: string;
    lineId: string;
    logicalDemandKey: string;
    openQty: number;
    warehouseQty: number;
    waitingQty: number;
    inWarehouse: boolean;
    willCall: boolean;
    approvedQty: number;
    shippedQty: number;
    invoice: string;
    customer: string;
    qty: number;
    priority: string;
    assignedTo: string;
    expectedAvailability: string;
    status: string;
    orderId: string;
    orderCreatedAt: string | null;
    firstPaymentAt: string | null;
    invoiceDate: string | null;
    priorityDate: string | null;
    priorityDateSource: "FIRST_PAYMENT" | "INVOICE_DATE" | "ORDER_CREATED" | "INVOICE_NUMBER";
    sourceInvoiceId: string | null;
    invoiceOrderedQty: number | null;
    provenInvoiceShippedQty: number;
    invoiceFullyShipped: boolean;
    balanceOwed: number;
    storedPosition: number | null;
    excludedFromQueue?: boolean;
  }>;
};

function outstandingInvoiceBalance(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return 0;
  const balance = Number((rawPayload as { Balance?: unknown }).Balance);
  return Number.isFinite(balance) ? Math.max(0, balance) : 0;
}

function formatShortDate(value: string | null | undefined) {
  return formatCalendarDate(value, {}, "Pending");
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatPriority(value: string | null | undefined) {
  return formatStatus(value ?? "NORMAL");
}

function normalizeSkuKey(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeQboSkuKeys(value: string | null | undefined) {
  return qboSkuCandidates(value).map(normalizeSkuKey).filter(Boolean) as string[];
}

const UNSORTED_GROUP = "Other / Unsorted";
const UNSORTED_GROUP_SORT = 9990;

/** Open demand is who still needs the product, not everyone who ever ordered it. */
function isOpenQueueLine(line: QueueLine) {
  return isOpenCustomerQueueLine(line);
}

function isActiveIncomingContainer(status: string | null | undefined) {
  return ["ORDERED", "PRODUCTION", "INBOUND"].includes(String(status ?? "").trim().toUpperCase());
}

function toRecordMap<T>(rows: T[], getKey: (row: T) => string | null, getValue: (row: T) => number) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = getKey(row);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + getValue(row));
  }
  return map;
}

type InventoryBaseDataset = {
  products: ProductRow[];
  aliases: ProductAliasRow[];
  transactions: InventoryTransactionRow[];
  containerLines: ContainerLineRow[];
  displayGroupData: Array<{ name: string | null; sort_order: number | null }>;
  oldErpProducts: OldErpProductSourceRow[];
};

const getCachedInventoryBaseDataset = unstable_cache(async (): Promise<InventoryBaseDataset> => {
  const supabase = getSupabaseAdmin();
  const [productData, aliases, transactions, containerLines, displayGroupData, oldErpProducts] = await Promise.all([
    fetchQueuePages((from, to) => supabase.from("products").select("id, sku, canonical_name, source_record_id, inventory_group, inventory_sort_order").neq("status", "Inactive").order("id").range(from, to), 1, 1000)
      .catch(() => fetchQueuePages((from, to) => supabase.from("products").select("id, sku, canonical_name, source_record_id").neq("status", "Inactive").order("id").range(from, to), 1, 1000)),
    fetchQueuePages((from, to) => supabase.from("product_aliases").select("product_id, alias").order("id").range(from, to), 1, 1000),
    loadInventoryStockHistory(supabase),
    fetchQueuePages((from, to) => supabase.from("container_lines").select("product_id, on_order_qty, received_qty, container_id, containers (container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date, port_date, entered_date)").order("id").range(from, to), 3),
    fetchQueuePages((from, to) => supabase.from("inventory_display_groups").select("name, sort_order").order("name").range(from, to)),
    fetchQueuePages((from, to) => supabase.from("old_erp_source_records").select("source_record_id, raw_payload").eq("source_container", "Products").order("id").range(from, to), 1, 1000),
  ]);
  const products = (productData as unknown as ProductRow[]).sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
  return { products, aliases, transactions, containerLines, displayGroupData, oldErpProducts } as unknown as InventoryBaseDataset;
}, ["inventory-base-read-model-complete-pages-v4"], { revalidate: 300, tags: [INVENTORY_READ_MODEL_CACHE_TAG] });

function getAssignmentLabel(line: QueueLine) {
  const allocations = line.inventory_allocations ?? [];
  if (allocations.length === 0) return "Unassigned";

  return allocations.map((allocation) => {
    if (allocation.source_type === "FLOOR") {
      return "On Floor";
    }

    if (allocation.source_type === "CONTAINER") {
      const number = allocation.containers?.container_number ?? "Container";
      const status = formatStatus(allocation.containers?.lifecycle_status);
      const eta = formatShortDate(allocation.containers?.eta_confirmed_date ?? allocation.containers?.eta_estimated_date);
      return `${number} · ${status} · ETA ${eta}`;
    }

    return "Unassigned";
  }).join("; ");
}

/** The full catalog projection shared by Inventory and Dashboard, before UI pagination. */
export async function loadInventoryDisplayModel(q = "") {
  const [inventoryBase, packageDimensionsBySku, sharedCanonicalQueue] = await Promise.all([
    getCachedInventoryBaseDataset(),
    getCachedPackageDimensionsBySku(),
    loadCanonicalCustomerQueue(),
  ]);
  return projectInventoryDisplayModel(inventoryBase, packageDimensionsBySku, sharedCanonicalQueue, q);
}

export function projectInventoryDisplayModel(
  inventoryBase: Awaited<ReturnType<typeof getCachedInventoryBaseDataset>>,
  packageDimensionsBySku: Record<string, PackageDimensions>,
  sharedCanonicalQueue: Awaited<ReturnType<typeof loadCanonicalCustomerQueue>>,
  q = "",
) {
  const { products, aliases, transactions, containerLines, displayGroupData, oldErpProducts } = inventoryBase;

  const displayGroups = displayGroupData as unknown as Array<{ name: string | null; sort_order: number | null }> | null;

  const groupSortByName = new Map<string, number>();
  for (const group of displayGroups ?? []) {
    if (group?.name) groupSortByName.set(group.name, Number(group.sort_order ?? UNSORTED_GROUP_SORT));
  }
  groupSortByName.set(UNSORTED_GROUP, UNSORTED_GROUP_SORT);

  const groupNames = [...groupSortByName.entries()].sort((left, right) => left[1] - right[1]).map(([name]) => name);

  const productRows = ((products ?? []) as ProductRow[]).filter(isOperationalInventoryProduct);
  const productAliasRows = (aliases ?? []) as ProductAliasRow[];
  const oldErpProductSourceRows = (oldErpProducts ?? []) as OldErpProductSourceRow[];
  const transactionRows = (transactions ?? []) as InventoryTransactionRow[];
  const containerLineRows = (containerLines ?? []) as ContainerLineRow[];
  const dedupedQueueLineRows = sharedCanonicalQueue.canonicalLines as QueueLine[];
  const fulfilledQtyByQboLineIdentity = new Map<string, number>();
  for (const line of dedupedQueueLineRows) {
    if (!line.qbo_invoice_line_id || !line.shipping_orders?.source_invoice_id || !line.product_id) continue;
    const key = `${line.shipping_orders.source_invoice_id}|${line.product_id}|${line.qbo_invoice_line_id}`;
    fulfilledQtyByQboLineIdentity.set(key, Math.max(fulfilledQtyByQboLineIdentity.get(key) ?? 0, Math.max(0, Number(line.fulfilled_qty ?? 0))));
  }
  const provenInvoiceShippedQtyByProduct = new Map<string, number>();
  for (const [key, quantity] of fulfilledQtyByQboLineIdentity) {
    const invoiceProductKey = key.split("|").slice(0, 2).join("|");
    provenInvoiceShippedQtyByProduct.set(invoiceProductKey, (provenInvoiceShippedQtyByProduct.get(invoiceProductKey) ?? 0) + quantity);
  }
  const productIdByAliasKey = new Map<string, string>();
  for (const product of productRows) {
    if (product.sku) productIdByAliasKey.set(normalizeSkuKey(product.sku), product.id);
  }
  for (const alias of productAliasRows) {
    if (alias.alias && alias.product_id) productIdByAliasKey.set(normalizeSkuKey(alias.alias), alias.product_id);
  }
  const allQboLineRows = sharedCanonicalQueue.qboInvoiceLines;
  const fulfilledQtyByQboInvoiceLineId = new Map<string, number>();
  for (const line of dedupedQueueLineRows) {
    if (!line.qbo_invoice_line_id) continue;
    fulfilledQtyByQboInvoiceLineId.set(
      line.qbo_invoice_line_id,
      Math.max(fulfilledQtyByQboInvoiceLineId.get(line.qbo_invoice_line_id) ?? 0, Math.max(0, Number(line.fulfilled_qty ?? 0))),
    );
  }
  const qboInvoiceLineRowsByInvoiceId = new Map<string, Array<{ id: string; ordered_qty?: number | null }>>();
  for (const qboLine of allQboLineRows as Array<{ id: string; qbo_invoice_id: string; ordered_qty?: number | null }>) {
    qboInvoiceLineRowsByInvoiceId.set(qboLine.qbo_invoice_id, [...(qboInvoiceLineRowsByInvoiceId.get(qboLine.qbo_invoice_id) ?? []), qboLine]);
  }
  const qboInvoiceFullyShippedIds = new Set<string>();
  for (const [invoiceId, lines] of qboInvoiceLineRowsByInvoiceId) {
    const physicalLines = lines.filter((line) => Number(line.ordered_qty ?? 0) > 0);
    if (physicalLines.length > 0 && physicalLines.every((line) => (fulfilledQtyByQboInvoiceLineId.get(line.id) ?? 0) >= Number(line.ordered_qty ?? 0))) {
      qboInvoiceFullyShippedIds.add(invoiceId);
    }
  }
  const invoiceQtyByInvoiceProduct = new Map<string, number>();
  for (const qboLine of allQboLineRows as Array<{ id: string; qbo_invoice_id: string; qbo_sku: string | null; product_id: string | null; ordered_qty?: number | null }>) {
    const qboProductId = qboLine.product_id ?? normalizeQboSkuKeys(qboLine.qbo_sku).map((key) => productIdByAliasKey.get(key)).find(Boolean) ?? null;
    const orderedQty = Math.max(0, Number(qboLine.ordered_qty ?? 0));
    if (qboProductId && orderedQty > 0) {
      const qtyKey = `${qboLine.qbo_invoice_id}|${qboProductId}`;
      invoiceQtyByInvoiceProduct.set(qtyKey, (invoiceQtyByInvoiceProduct.get(qtyKey) ?? 0) + orderedQty);
    }
  }
  const archivedItemCodeBySourceRecordId = new Map<string, string>();
  for (const source of oldErpProductSourceRows) {
    const sourceId = String(source.source_record_id ?? "").trim();
    const itemCode = String(source.raw_payload?.itemCode ?? source.raw_payload?.qbMatchText ?? "").trim().toUpperCase();
    if (sourceId && itemCode && !/^\d+$/.test(itemCode)) archivedItemCodeBySourceRecordId.set(sourceId, itemCode);
  }

  const { operationalSkuByProduct, demandSkuCountsByProduct } = inventoryOperationalIdentity(productRows, productAliasRows, Object.fromEntries(archivedItemCodeBySourceRecordId), dedupedQueueLineRows);
  const canonicalInventoryKeyByProductId = new Map(productRows.map((product) => [
    product.id,
    canonicalSkuKey(operationalSkuByProduct.get(product.id) ?? product.sku ?? "") || product.id,
  ]));
  const onFloorByProduct = toRecordMap(
    transactionRows.filter((row) => row.bucket === "ON_FLOOR"),
    (row) => row.product_id,
    (row) => Number(row.delta ?? 0),
  );
  const explicitStockOwnerProductIds = new Set(
    transactionRows
      .filter((row) => row.bucket === "ON_FLOOR" && ["ADJUSTMENT", "CONTAINER_RECEIVED", "RECOUNT"].includes(String(row.source_type ?? "").toUpperCase()))
      .map((row) => row.product_id)
      .filter((productId): productId is string => Boolean(productId)),
  );
  // A zero balance remains authoritative when an operator counted/recounted it.
  // Shipment rows alone must never replace the physical stock owner.
  const stockOwnerProductIds = authoritativeStockProductIds(
    productRows,
    canonicalInventoryKeyByProductId,
    new Set(onFloorByProduct.keys()),
    explicitStockOwnerProductIds,
  );

  const openDemandByProduct = toRecordMap(
    dedupedQueueLineRows.filter(isOpenQueueLine),
    (row) => row.product_id,
    (row) => Math.max(0, Number(row.approved_qty ?? 0) - Number(row.fulfilled_qty ?? 0)),
  );

  const floorCommittedByProduct = new Map<string, number>();
  const committedByProductContainer = new Map<string, number>();
  for (const line of dedupedQueueLineRows) {
    for (const allocation of line.inventory_allocations ?? []) {
      if (allocation.allocation_status === "RELEASED") continue;
      const quantity = Number(allocation.quantity ?? 0);
      if (!line.product_id || quantity <= 0) continue;
      if (allocation.source_type === "FLOOR") {
        floorCommittedByProduct.set(line.product_id, (floorCommittedByProduct.get(line.product_id) ?? 0) + quantity);
      }
      if (allocation.source_type === "CONTAINER" && allocation.container_id) {
        const key = `${line.product_id}|${allocation.container_id}`;
        committedByProductContainer.set(key, (committedByProductContainer.get(key) ?? 0) + quantity);
      }
    }
  }

  const incomingContainersByProduct = new Map<string, InventoryViewRow["incomingContainers"]>();

  for (const line of containerLineRows) {
    if (!line.product_id || !isActiveIncomingContainer(line.containers?.lifecycle_status)) continue;
    const qty = Math.max(0, Number(line.on_order_qty ?? 0) - Number(line.received_qty ?? 0));
    if (qty <= 0) continue;
    const eta = line.containers?.eta_confirmed_date ?? line.containers?.eta_estimated_date ?? line.containers?.port_date;
    const number = line.containers?.container_number;

    if (!number) continue;
    const committed = committedByProductContainer.get(`${line.product_id}|${line.container_id}`) ?? 0;
    const rows = incomingContainersByProduct.get(line.product_id) ?? [];
    rows.push({
      containerNumber: number,
      qty,
      committed,
      available: Math.max(0, qty - committed),
      eta: formatShortDate(eta),
      etaSort: eta ? new Date(eta).toISOString() : line.containers?.entered_date ? new Date(line.containers.entered_date).toISOString() : "9999-12-31",
      status: formatStatus(line.containers?.lifecycle_status),
    });
    incomingContainersByProduct.set(line.product_id, rows);
  }

  const queueByProduct = new Map<string, InventoryViewRow["customerQueue"]>();

  for (const line of dedupedQueueLineRows) {
    if (!line.product_id || !isOpenQueueLine(line)) continue;
    const sharedQueueRow = sharedCanonicalQueue.queueByLineId.get(line.id);
    if (!sharedQueueRow) continue;

    const operationalOpenQty = Math.max(0, customerQueueObligationQty(line) - Number(line.fulfilled_qty ?? 0));
    const sourceInvoiceId = line.shipping_orders?.source_invoice_id ?? null;
    const invoiceOrderedQty = sourceInvoiceId && line.product_id
      ? invoiceQtyByInvoiceProduct.get(`${sourceInvoiceId}|${line.product_id}`) ?? null
      : null;
    const provenInvoiceShippedQty = sourceInvoiceId && line.product_id
      ? provenInvoiceShippedQtyByProduct.get(`${sourceInvoiceId}|${line.product_id}`) ?? 0
      : 0;
    const invoiceFullyShipped = Boolean(sourceInvoiceId && qboInvoiceFullyShippedIds.has(sourceInvoiceId));
    const shippedQty = Math.max(0, Number(line.fulfilled_qty ?? 0));
    const approvedQty = invoiceOrderedQty ?? customerQueueObligationQty(line);
    const normalizedShippedQty = Math.min(approvedQty, shippedQty);
    const openQty = Math.max(0, approvedQty - normalizedShippedQty);
    const qty = approvedQty;

    const invoice = line.shipping_orders?.qbo_invoices?.invoice_number ?? "—";
    const customer = line.shipping_orders?.qbo_invoices?.customers?.company_name
      ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
      ?? line.shipping_orders?.legacy_customer_name
      ?? "Customer pending";
    const warehouseDisplay = getWarehouseDemandDisplay({
      openQty: operationalOpenQty,
      warehouseStatus: line.warehouse_status,
      willCall: line.shipping_orders?.fulfillment_method === "WILL_CALL",
    });

    const row = {
      position: line.queue_position_start != null
        ? `${line.queue_position_start}${Number(line.queue_position_count ?? 0) > 1 ? `-${line.queue_position_start + Number(line.queue_position_count) - 1}` : ""}`
        : "—",
      lineId: line.id,
      logicalDemandKey: demandLineIdentity(line),
      openQty,
      warehouseQty: warehouseDisplay.warehouseQty,
      waitingQty: warehouseDisplay.waitingQty,
      inWarehouse: warehouseDisplay.inWarehouse,
      willCall: warehouseDisplay.willCall,
      approvedQty,
      shippedQty: normalizedShippedQty,
      invoice,
      customer,
      qty,
      priority: formatPriority(line.priority),
      assignedTo: getAssignmentLabel(line),
      expectedAvailability: line.inventory_allocations?.some((allocation) => allocation.source_type === "FLOOR")
        ? "Available now"
        : line.inventory_allocations?.find((allocation) => allocation.source_type === "CONTAINER")?.containers?.container_number
          ? `Container ${line.inventory_allocations.find((allocation) => allocation.source_type === "CONTAINER")?.containers?.container_number} · ETA ${formatShortDate(line.inventory_allocations.find((allocation) => allocation.source_type === "CONTAINER")?.containers?.eta_confirmed_date ?? line.inventory_allocations.find((allocation) => allocation.source_type === "CONTAINER")?.containers?.eta_estimated_date)}`
          : "Waiting for inventory",
      status: formatStatus(line.warehouse_status ?? line.approval_status),
      orderId: line.shipping_orders?.id ?? "",
      sourceInvoiceId,
      orderCreatedAt: line.shipping_orders?.created_at ?? null,
      firstPaymentAt: sharedQueueRow.firstPaymentAt,
      invoiceDate: sharedQueueRow.invoiceDate,
      priorityDate: sharedQueueRow.priorityDate,
      priorityDateSource: sharedQueueRow.priorityDateSource,
      invoiceOrderedQty,
      provenInvoiceShippedQty,
      invoiceFullyShipped,
      balanceOwed: outstandingInvoiceBalance(line.shipping_orders?.qbo_invoices?.raw_payload),
      storedPosition: line.queue_position_start,
      manuallyMoved: Number(sharedQueueRow.manualPosition ?? 0) > 0,
      excludedFromQueue: false,
    };

    const arr = queueByProduct.get(line.product_id) ?? [];
    arr.push(row);
    queueByProduct.set(line.product_id, arr);
  }

  for (const [productId, queue] of queueByProduct) {
    queueByProduct.set(productId, projectCanonicalCustomerQueue(queue).map((row) => ({
      ...row,
      position: sharedCanonicalQueue.queueByLineId.get(row.lineId)?.position ?? row.position,
    })));
  }

  const coverageFloorByProduct = new Map<string, number>();
  for (const [productId, onFloor] of onFloorByProduct) {
    if (!stockOwnerProductIds.has(productId)) continue;
    const productKey = canonicalInventoryKeyByProductId.get(productId) ?? productId;
    coverageFloorByProduct.set(productKey, (coverageFloorByProduct.get(productKey) ?? 0) + onFloor);
  }

  const coverageQueueByProduct = new Map<string, OpenQueueLine[]>();
  for (const line of dedupedQueueLineRows) {
    if (!line.product_id || !isOpenQueueLine(line)) continue;
    const sharedQueueRow = sharedCanonicalQueue.queueByLineId.get(line.id);
    if (!sharedQueueRow) continue;
    const queuePosition = Number.parseInt(sharedQueueRow.position.split("-")[0] ?? "", 10);
    const productKey = canonicalInventoryKeyByProductId.get(line.product_id) ?? line.product_id;
    // The canonical queue can reconcile several invoice representations into a
    // larger obligation than the surviving local line. Use its remaining units
    // for coverage too, so Inventory and container forecasts consume the same supply.
    const remainingQty = Math.max(0, sharedQueueRow.openQty ?? (customerQueueObligationQty(line) - Number(line.fulfilled_qty ?? 0)));
    const rows = coverageQueueByProduct.get(productKey) ?? [];
    rows.push({
      id: line.id,
      product_id: productKey,
      remaining_qty: remainingQty,
      priority: line.priority,
      queue_position_start: Number.isFinite(queuePosition) ? queuePosition : null,
      approved_at: null,
      created_at: line.shipping_orders?.created_at ?? new Date().toISOString(),
      has_live_allocation: (line.inventory_allocations ?? []).some((allocation) => (allocation.allocation_status ?? "ALLOCATED") === "ALLOCATED"),
      fulfillment_source: inventoryCoverageSource(line),
      ...lineSourceReservations(remainingQty, line.warehouse_status, line.inventory_allocations),
    });
    coverageQueueByProduct.set(productKey, rows);
  }

  const coverageContainerSupplyByProduct = new Map<string, ProductContainerSupply[]>();
  const coverageSupplyByProductContainer = new Map<string, ProductContainerSupply>();
  for (const line of containerLineRows) {
    if (!line.product_id || !line.container_id || !isActiveIncomingContainer(line.containers?.lifecycle_status)) continue;
    const qty = Math.max(0, Number(line.on_order_qty ?? 0) - Number(line.received_qty ?? 0));
    if (qty <= 0) continue;
    const productKey = canonicalInventoryKeyByProductId.get(line.product_id) ?? line.product_id;
    const supplyKey = `${productKey}|${line.container_id}`;
    const existing = coverageSupplyByProductContainer.get(supplyKey);
    if (existing) {
      existing.available_qty = Math.max(existing.available_qty, qty);
      continue;
    }
    coverageSupplyByProductContainer.set(supplyKey, {
      container_id: line.container_id,
      container_number: line.containers?.container_number ?? null,
      available_qty: qty,
      eta_confirmed_date: line.containers?.eta_confirmed_date ?? null,
      eta_estimated_date: line.containers?.eta_estimated_date ?? line.containers?.port_date ?? null,
      entered_date: line.containers?.entered_date ?? null,
      lifecycle_status: line.containers?.lifecycle_status ?? null,
    });
  }
  for (const [supplyKey, supply] of coverageSupplyByProductContainer) {
    const [productKey] = supplyKey.split("|");
    coverageContainerSupplyByProduct.set(productKey, [...(coverageContainerSupplyByProduct.get(productKey) ?? []), supply]);
  }

  const coverageByProduct = new Map<string, ReturnType<typeof resolveProductCoverage>>();
  const coverageByLineId = new Map<string, LineCoverage>();
  for (const productKey of new Set([...coverageFloorByProduct.keys(), ...coverageQueueByProduct.keys(), ...coverageContainerSupplyByProduct.keys()])) {
    const coverage = resolveProductCoverage(productKey, {
      floorAvailableByProduct: new Map([[productKey, Math.max(0, coverageFloorByProduct.get(productKey) ?? 0)]]),
      queueLinesByProduct: coverageQueueByProduct,
      containerSupplyByProduct: coverageContainerSupplyByProduct,
    });
    coverageByProduct.set(productKey, coverage);
    for (const [lineId, lineCoverage] of coverage.lines) coverageByLineId.set(lineId, lineCoverage);
  }

  const canonicalGroups = new Map<string, InventoryViewRow>();
  for (const product of productRows) {
    const displaySku = operationalSkuByProduct.get(product.id) ?? product.sku ?? "—";
    const canonicalKey = canonicalSkuKey(displaySku) || canonicalSkuKey(product.sku) || product.id;
    const { manufacturer, title } = splitProductTitle(product.canonical_name);
    const preferredDemandSku = demandSkuCountsByProduct.has(product.id) ? displaySku : null;

    const group = canonicalGroups.get(canonicalKey) ?? {
      productId: product.id,
      stockProductIds: [],
      productIds: [],
      sku: displaySku,
      productName: preferredDemandSku ?? title ?? "Unnamed Product",
      storedName: product.canonical_name ?? "",
      manufacturer,
      group: UNSORTED_GROUP,
      groupSort: UNSORTED_GROUP_SORT,
      sortOrder: Number.MAX_SAFE_INTEGER,
      onFloor: 0,
      openDemand: 0,
      floorCommitted: 0,
      availableNow: 0,
      backorderedNow: 0,
      incoming: 0,
      availableAfterIncoming: 0,
      backorderedAfterIncoming: 0,
      nextEta: "—",
      packageDimensions: packageDimensionsBySku[canonicalKey] ?? null,
      incomingContainers: [],
      customerQueue: [],
    };

    if (stockOwnerProductIds.has(product.id)) {
      group.stockProductIds.push(product.id);
      group.onFloor += onFloorByProduct.get(product.id) ?? 0;
    }
    group.openDemand += openDemandByProduct.get(product.id) ?? 0;
    group.floorCommitted += floorCommittedByProduct.get(product.id) ?? 0;
    group.customerQueue = [...group.customerQueue, ...(queueByProduct.get(product.id) ?? [])];
    group.productIds = [...group.productIds, product.id];
    if (!group.packageDimensions) group.packageDimensions = packageDimensionsBySku[canonicalKey] ?? null;

    // Merged legacy identities can disagree; keep the earliest real placement.
    const assignedGroup = product.inventory_group?.trim();
    if (assignedGroup) {
      const assignedGroupSort = groupSortByName.get(assignedGroup) ?? UNSORTED_GROUP_SORT - 1;
      const assignedSortOrder = product.inventory_sort_order ?? Number.MAX_SAFE_INTEGER;
      if (assignedGroupSort < group.groupSort || (assignedGroupSort === group.groupSort && assignedSortOrder < group.sortOrder)) {
        group.group = assignedGroup;
        group.groupSort = assignedGroupSort;
        group.sortOrder = assignedSortOrder;
      }
    }

    // Container supply is recorded per part number, so it belongs to the canonical SKU, not to a
    // single product id. Duplicate legacy identities carry the same container line, so merge by
    // container number taking the largest quantity instead of summing (which would double count).
    const containersByNumber = new Map(group.incomingContainers.map((container) => [container.containerNumber, container]));
    for (const container of incomingContainersByProduct.get(product.id) ?? []) {
      const existing = containersByNumber.get(container.containerNumber);
      if (existing) {
        existing.qty = Math.max(existing.qty, container.qty);
        existing.committed = Math.max(existing.committed, container.committed);
        existing.available = Math.max(0, existing.qty - existing.committed);
      } else {
        containersByNumber.set(container.containerNumber, { ...container });
      }
    }
    group.incomingContainers = Array.from(containersByNumber.values());
    group.incoming = group.incomingContainers.reduce((sum, container) => sum + container.qty, 0);

    canonicalGroups.set(canonicalKey, group);
  }

  const displayRows = Array.from(canonicalGroups.values())
    .map((group) => {
      // Customer list displays one row per invoice/order for a product, and quantity is
      // authoritative to invoice line quantities when available.
      group.customerQueue = mergeOpenCustomerDemand(group.customerQueue);
      group.openDemand = group.customerQueue.reduce((sum, item) => sum + item.openQty, 0);

      // Unallocated open demand still consumes floor stock, matching the OLD_ERP Available = On Floor - Sold rule.
      const committedFloor = getCommittedFloor({
        onFloor: group.onFloor, openDemand: group.openDemand, floorCommitted: group.floorCommitted,
        containerReserved: group.incomingContainers.reduce((sum, container) => sum + Math.min(container.qty, container.committed), 0),
      });
      let groupIncomingDemand = Math.max(0, group.openDemand - committedFloor);
      const incomingContainers = group.incomingContainers
        .slice()
        .sort((left, right) => left.etaSort.localeCompare(right.etaSort))
        .map((container) => {
          const resolverCommitted = Math.min(container.qty, groupIncomingDemand);
          groupIncomingDemand = Math.max(0, groupIncomingDemand - resolverCommitted);
          const committed = Math.max(container.committed, resolverCommitted);
          return {
            ...container,
            committed,
            available: Math.max(0, container.qty - committed),
          };
        });
      const customerQueue = group.customerQueue
        .slice()
        .sort((left, right) => {
          const leftPosition = left.position === "—" ? Number.MAX_SAFE_INTEGER : Number(left.position);
          const rightPosition = right.position === "—" ? Number.MAX_SAFE_INTEGER : Number(right.position);
          return leftPosition - rightPosition || left.invoice.localeCompare(right.invoice) || left.lineId.localeCompare(right.lineId);
        })
        .map((item) => item);

      const coveredQueue = customerQueue.map((item) => {
        const coverage = coverageByLineId.get(item.lineId);
        if (!coverage || item.openQty <= 0) return { ...item, expectedAvailability: "Waiting for inventory" };
        const parts = coverage.allocations.map((allocation) => {
          if (allocation.sourceType === "WAREHOUSE") return `${allocation.quantity} Warehouse · Available now`;
          if (allocation.sourceType === "CONTAINER") return `${allocation.quantity} ${allocation.sourceLabel} · ETA ${allocation.etaDate ? formatShortDate(allocation.etaDate) : "Pending"}`;
          return `${allocation.quantity} Unassigned`;
        });
        const status = coverage.unassignedQty > 0
          ? coverage.coveredQty > 0 ? "Partially covered" : "Waiting for inventory"
          : coverage.incomingQty > 0 ? "Incoming" : "Available now";
        const completeEta = coverage.completeEtaDate ? ` · Complete ETA ${formatShortDate(coverage.completeEtaDate)}` : "";
        return { ...item, expectedAvailability: `${parts.join(" + ")}${completeEta}`, status };
      });
      const afterIncoming = getAfterIncomingInventory({
        onFloor: group.onFloor,
        incoming: group.incoming,
        openDemand: group.openDemand,
      });

      return {
        ...group,
        incomingContainers,
        customerQueue: coveredQueue,
        availableNow: Math.max(0, group.onFloor - committedFloor),
        backorderedNow: getBackorderedNow({ onFloor: group.onFloor, openDemand: group.openDemand }),
        ...afterIncoming,
        nextEta: incomingContainers[0] ? `${incomingContainers[0].containerNumber} · ${incomingContainers[0].eta}` : "—",
      };
    })
    .filter((row) => {
      if (!q) return true;
      return `${row.sku} ${row.productName}`.toLowerCase().includes(q);
    })
    .sort((left, right) => {
      if (left.groupSort !== right.groupSort) return left.groupSort - right.groupSort;
      if (left.group !== right.group) return left.group.localeCompare(right.group);
      if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
      return left.sku.localeCompare(right.sku, undefined, { numeric: true });
    });

  // Local and imported representations must resolve to the same physical obligation.
  for (const [lineId, queueRow] of sharedCanonicalQueue.queueByLineId) {
    const coverage = coverageByLineId.get(queueRow.lineId);
    if (coverage && !coverageByLineId.has(lineId)) coverageByLineId.set(lineId, coverage);
  }
  return { displayRows, groupNames, coverageByLineId, coverageByProduct,
    containerSupplyByProduct: coverageContainerSupplyByProduct,
    canonicalProductKeyById: canonicalInventoryKeyByProductId, canonicalQueue: sharedCanonicalQueue };

}
