import Link from "next/link";
import { Fragment } from "react";
import { createProductAction } from "@/app/(protected)/inventory/actions";
import { AddProductModal } from "@/app/(protected)/inventory/add-product-modal";
import { AdminModeToggle } from "@/app/(protected)/inventory/admin-mode-toggle";
import { AdminRowEditor } from "@/app/(protected)/inventory/admin-row-editor";
import { CustomerDemandDropdown } from "@/app/(protected)/inventory/customer-demand-dropdown";
import { DisplayOrderButton } from "@/app/(protected)/inventory/display-order-button";
import { IncomingDropdown } from "@/app/(protected)/inventory/incoming-dropdown";
import { requireUser } from "@/lib/auth";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { CLOSED_DEMAND_STATES, demandLineIdentity, dedupeDemandLines, isOpenDemandLine } from "@/lib/demand/product-demand";
import { getWarehouseDemandDisplay } from "@/lib/demand/display-status";
import { resolveProductCoverage, type LineCoverage, type OpenQueueLine, type ProductContainerSupply } from "@/lib/fulfillment/suggested-allocation";
import { qboSkuCandidates } from "@/lib/orders/quickbooks-refresh";
import { splitProductTitle } from "@/lib/product-title";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type ProductRow = {
  id: string;
  sku: string | null;
  canonical_name: string | null;
  inventory_group?: string | null;
  inventory_sort_order?: number | null;
};

type InventoryTransactionRow = {
  product_id: string | null;
  bucket: string | null;
  delta: number | null;
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
    created_at?: string | null;
    first_payment_at?: string | null;
    legacy_customer_name: string | null;
    fulfillment_method?: "SHIP" | "WILL_CALL" | null;
    qbo_invoices?: {
      invoice_number: string | null;
      raw_payload?: { PrivateNote?: string | null } | null;
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
  incoming: number;
  availableAfterIncoming: number;
  backorderedAfterIncoming: number;
  nextEta: string;
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
  }>;
};

function formatNumber(value: number) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  if (Number.isInteger(rounded)) return new Intl.NumberFormat("en-US").format(rounded);
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rounded);
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

function normalizeQboSkuKey(value: string | null | undefined) {
  return normalizeQboSkuKeys(value).at(-1) ?? normalizeSkuKey(value);
}

function normalizeQboSkuKeys(value: string | null | undefined) {
  return qboSkuCandidates(value).map(normalizeSkuKey).filter(Boolean) as string[];
}

const MANUFACTURER_PREFIX = /^(HL|HK|FB|YZ)-/i;

/** Legacy data reuses AR-1 for two different ramps, so that code must not collapse. */
const PREFIX_MERGE_EXCEPTIONS = new Set(["AR1"]);

/** The manufacturer code is not part of the product identity, so 4PC-6 and HK-4PC-6 are one row. */
function canonicalSkuKey(value: string | null | undefined) {
  const full = normalizeSkuKey(value);
  const stripped = normalizeSkuKey(String(value ?? "").replace(MANUFACTURER_PREFIX, ""));
  if (!stripped || PREFIX_MERGE_EXCEPTIONS.has(stripped)) return full;
  return stripped;
}

const UNSORTED_GROUP = "Other / Unsorted";
const UNSORTED_GROUP_SORT = 9990;

const CLOSED_QUEUE_STATES = CLOSED_DEMAND_STATES;

/** Open demand is who still needs the product, not everyone who ever ordered it. */
function isOpenQueueLine(line: QueueLine) {
  return isOpenDemandLine(line);
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

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; mapError?: string; mapMessage?: string }>;
}) {
  const currentUser = await requireUser();
  const adminMode = await isAdminUnlockedForUser(currentUser.id);
  const supabase = getSupabaseAdmin();
  const params = await searchParams;
  const q = String(params.q ?? "").trim().toLowerCase();
  const mapError = String(params.mapError ?? "").trim();
  const mapMessage = String(params.mapMessage ?? "").trim();
  const { error: firstPaymentColumnError } = await supabase.from("shipping_orders").select("first_payment_at").limit(1);
  const firstPaymentColumnAvailable = !firstPaymentColumnError;
  const shippingOrderPaymentField = firstPaymentColumnAvailable ? "first_payment_at," : "";
  const { error: duplicateParentColumnError } = await supabase.from("shipping_orders").select("duplicate_of_order_id").limit(1);
  const duplicateParentColumnAvailable = !duplicateParentColumnError;
  const duplicateParentField = duplicateParentColumnAvailable ? "duplicate_of_order_id," : "";
  const { error: cancellationColumnError } = await supabase.from("shipping_orders").select("cancellation_status").limit(1);
  const cancellationColumnAvailable = !cancellationColumnError;
  const cancellationField = cancellationColumnAvailable ? "cancellation_status," : "";

  const [
    productsResult,
    { data: aliases },
    { data: transactions },
    { data: containerLines },
    { data: queueLines },
  ] = await Promise.all([
    supabase
      .from("products")
      .select("id, sku, canonical_name, inventory_group, inventory_sort_order")
      .neq("status", "Inactive")
      .order("sku", { ascending: true }),
    supabase.from("product_aliases").select("product_id, alias"),
    supabase.from("inventory_transactions").select("product_id, bucket, delta"),
    supabase
      .from("container_lines")
      .select("product_id, on_order_qty, received_qty, container_id, containers (container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date, port_date)"),
    supabase
      .from("shipping_order_lines")
      .select(`
        id,
        product_id,
        approved_qty,
        fulfilled_qty,
        approval_status,
        fulfillment_status,
        fulfillment_source,
        priority,
        warehouse_status,
        queue_position_start,
        queue_position_count,
        source_system,
        legacy_item_code,
        qbo_invoice_line_id,
        source_record_id,
        shipping_orders (
          id,
          source_invoice_id,
          ${duplicateParentField}
          created_at,
          fulfillment_method,
          ${shippingOrderPaymentField}
          order_number,
          legacy_customer_name,
          qbo_invoices (
            invoice_number,
            raw_payload,
            customers (company_name, full_name)
          )
        ),
        inventory_allocations (
          source_type,
          container_id,
          quantity,
          allocation_status,
          containers (container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date)
        )
      `)
      .in("approval_status", ["APPROVED", "PARTIAL", "FULFILLED"])
      .neq("fulfillment_status", "CANCELLED")
      .order("queue_position_start", { ascending: true, nullsFirst: false }),
  ]);

  // Display ordering is optional: the page still renders if migration 202608140003 has not been applied.
  let products = productsResult.data as unknown as ProductRow[] | null;
  if (productsResult.error) {
    const fallback = await supabase.from("products").select("id, sku, canonical_name").neq("status", "Inactive").order("sku", { ascending: true });
    products = fallback.data as unknown as ProductRow[] | null;
  }

  const { data: displayGroupData } = await supabase
    .from("inventory_display_groups")
    .select("name, sort_order")
    .order("sort_order", { ascending: true });

  const displayGroups = displayGroupData as unknown as Array<{ name: string | null; sort_order: number | null }> | null;

  const groupSortByName = new Map<string, number>();
  for (const group of displayGroups ?? []) {
    if (group?.name) groupSortByName.set(group.name, Number(group.sort_order ?? UNSORTED_GROUP_SORT));
  }
  groupSortByName.set(UNSORTED_GROUP, UNSORTED_GROUP_SORT);

  const groupNames = [...groupSortByName.entries()].sort((left, right) => left[1] - right[1]).map(([name]) => name);

  const productRows = (products ?? []) as ProductRow[];
  const productAliasRows = (aliases ?? []) as ProductAliasRow[];
  const transactionRows = (transactions ?? []) as InventoryTransactionRow[];
  const containerLineRows = (containerLines ?? []) as ContainerLineRow[];
  const queueLineRows = (queueLines ?? []) as unknown as QueueLine[];
  const sourceInvoiceIds = [...new Set(queueLineRows.map((line) => line.shipping_orders?.source_invoice_id).filter(Boolean))] as string[];
  const orderNumbers = [...new Set(queueLineRows.map((line) => line.shipping_orders?.order_number).filter(Boolean))] as string[];
  const productIdByAliasKey = new Map<string, string>();
  for (const product of productRows) {
    if (product.sku) productIdByAliasKey.set(normalizeSkuKey(product.sku), product.id);
  }
  for (const alias of productAliasRows) {
    if (alias.alias && alias.product_id) productIdByAliasKey.set(normalizeSkuKey(alias.alias), alias.product_id);
  }
  const { data: qboLineRows } = sourceInvoiceIds.length
    ? await supabase.from("qbo_invoice_lines").select("id,qbo_invoice_id,qbo_sku,product_id").in("qbo_invoice_id", sourceInvoiceIds)
    : { data: [] };
  const { data: qboParentRows } = orderNumbers.length
    ? await supabase.from("shipping_orders").select(`id,order_number,source_invoice_id,source_type,${duplicateParentField}${cancellationField}qbo_invoices(raw_payload)`).in("order_number", orderNumbers).eq("source_type", "QBO_INVOICE")
    : { data: [] };
  const typedQboParentRows = (qboParentRows ?? []) as unknown as Array<{ id: string; order_number: string | null; source_invoice_id: string | null; duplicate_of_order_id?: string | null; cancellation_status?: string | null; qbo_invoices?: { raw_payload?: { PrivateNote?: string | null } | null } | null }>;
  const qboParentByOrderNumber = new Map(typedQboParentRows.filter((row) => !row.duplicate_of_order_id && String(row.cancellation_status ?? "").toUpperCase() !== "CANCELLED" && String(row.qbo_invoices?.raw_payload?.PrivateNote ?? "").toUpperCase() !== "VOIDED").map((row) => [String(row.order_number), row]));
  const qboParentInvoiceIds = [...new Set(typedQboParentRows.map((row) => row.source_invoice_id).filter(Boolean))] as string[];
  const extraQboLineRows = qboParentInvoiceIds.length
    ? await supabase.from("qbo_invoice_lines").select("id,qbo_invoice_id,qbo_sku,product_id").in("qbo_invoice_id", qboParentInvoiceIds)
    : { data: [] };
  const allQboLineRows = [...(qboLineRows ?? []), ...(extraQboLineRows.data ?? [])].filter((row, index, rows) => rows.findIndex((candidate) => candidate.id === row.id) === index);
  const qboCandidatesByParentProduct = new Map<string, Array<{ id: string; qbo_sku: string | null; product_id: string | null }>>();
  for (const qboLine of allQboLineRows as Array<{ id: string; qbo_invoice_id: string; qbo_sku: string | null; product_id: string | null }>) {
    const qboProductId = qboLine.product_id ?? normalizeQboSkuKeys(qboLine.qbo_sku).map((key) => productIdByAliasKey.get(key)).find(Boolean) ?? null;
    const key = `${qboLine.qbo_invoice_id}|${qboProductId ?? normalizeSkuKey(qboLine.qbo_sku)}`;
    const candidates = qboCandidatesByParentProduct.get(key) ?? [];
    candidates.push(qboLine);
    qboCandidatesByParentProduct.set(key, candidates);
  }
  const bridgedQueueLineRows = queueLineRows.map((line) => {
    const parentFields = {
      parent_duplicate_of_order_id: line.shipping_orders?.duplicate_of_order_id ?? null,
      parent_cancellation_status: line.shipping_orders?.cancellation_status ?? null,
      parent_qbo_voided: String(line.shipping_orders?.qbo_invoices?.raw_payload?.PrivateNote ?? "").trim().toUpperCase() === "VOIDED",
    };
    if (line.qbo_invoice_line_id || !line.product_id) return { ...line, ...parentFields };
    const qboParent = qboParentByOrderNumber.get(String(line.shipping_orders?.order_number ?? ""));
    const bridgeInvoiceId = qboParent?.source_invoice_id ?? line.shipping_orders?.source_invoice_id;
    if (!bridgeInvoiceId) return { ...line, ...parentFields };
    const productKey = `${bridgeInvoiceId}|${line.product_id}`;
    const directCandidates = qboCandidatesByParentProduct.get(productKey) ?? [];
    const skuCandidates = allQboLineRows.filter((qboLine) => {
      const row = qboLine as { qbo_invoice_id: string; qbo_sku: string | null; product_id: string | null };
      const qboKeys = normalizeQboSkuKeys(row.qbo_sku);
      const lineKeys = normalizeQboSkuKeys(line.legacy_item_code);
      return row.qbo_invoice_id === bridgeInvoiceId && qboKeys.some((key) => lineKeys.includes(key));
    });
    const candidates = directCandidates.length === 1 ? directCandidates : skuCandidates;
    return candidates.length === 1 ? { ...line, ...parentFields, logical_demand_key: candidates[0].id } : { ...line, ...parentFields };
  });
  const activeQueueLineRows = bridgedQueueLineRows.filter((line) =>
    !line.shipping_orders?.duplicate_of_order_id
    && String(line.shipping_orders?.cancellation_status ?? "").trim().toUpperCase() !== "CANCELLED"
    && String(line.shipping_orders?.qbo_invoices?.raw_payload?.PrivateNote ?? "").trim().toUpperCase() !== "VOIDED",
  );
  const dedupedQueueLineRows = dedupeDemandLines(activeQueueLineRows);
  const manualMappingSkus = new Set<string>();
  const { data: manualMappingRows } = await supabase
    .from("manual_product_mapping_queue")
    .select("source_sku")
    .eq("status", "OPEN");
  for (const row of (manualMappingRows ?? []) as unknown as Array<{ source_sku: string | null }>) manualMappingSkus.add(normalizeSkuKey(row.source_sku));

  const operationalSkuByProduct = new Map<string, string>();
  for (const alias of productAliasRows) {
    if (!alias.product_id || !alias.alias) continue;
    const candidate = alias.alias.trim().toUpperCase();
    if (!candidate || /^\d+$/.test(candidate)) continue;
    if (!operationalSkuByProduct.has(alias.product_id)) operationalSkuByProduct.set(alias.product_id, candidate);
  }

  const demandSkuCountsByProduct = new Map<string, Map<string, number>>();
  for (const line of dedupedQueueLineRows) {
    if (!line.product_id || !isOpenQueueLine(line) || !line.legacy_item_code) continue;
    const candidate = qboSkuCandidates(line.legacy_item_code).at(-1) ?? line.legacy_item_code.trim().toUpperCase();
    if (!candidate || /^\d+$/.test(candidate)) continue;
    const counts = demandSkuCountsByProduct.get(line.product_id) ?? new Map<string, number>();
    counts.set(candidate, (counts.get(candidate) ?? 0) + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)));
    demandSkuCountsByProduct.set(line.product_id, counts);
  }
  for (const [productId, counts] of demandSkuCountsByProduct) {
    const preferred = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
    if (preferred) operationalSkuByProduct.set(productId, preferred);
  }

  const onFloorByProduct = toRecordMap(
    transactionRows.filter((row) => row.bucket === "ON_FLOOR"),
    (row) => row.product_id,
    (row) => Number(row.delta ?? 0),
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
      etaSort: eta ? new Date(eta).toISOString() : "9999-12-31",
      status: formatStatus(line.containers?.lifecycle_status),
    });
    incomingContainersByProduct.set(line.product_id, rows);
  }

  const queueByProduct = new Map<string, InventoryViewRow["customerQueue"]>();

  for (const line of dedupedQueueLineRows) {
    if (!line.product_id || !isOpenQueueLine(line)) continue;
    if (manualMappingSkus.has(normalizeSkuKey(line.products?.sku)) || manualMappingSkus.has(normalizeSkuKey(line.legacy_item_code)) || String(line.shipping_orders?.order_number ?? "").trim() === "126037") continue;

    const openQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    const qty = openQty;

    const invoice = line.shipping_orders?.qbo_invoices?.invoice_number ?? "—";
    const customer = line.shipping_orders?.qbo_invoices?.customers?.company_name
      ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
      ?? line.shipping_orders?.legacy_customer_name
      ?? "Customer pending";
    const warehouseDisplay = getWarehouseDemandDisplay({
      openQty,
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
      approvedQty: Math.max(0, Number(line.approved_qty ?? 0)),
      shippedQty: Math.max(0, Number(line.fulfilled_qty ?? 0)),
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
      orderCreatedAt: line.shipping_orders?.created_at ?? null,
      firstPaymentAt: line.shipping_orders?.first_payment_at ?? null,
    };

    const arr = queueByProduct.get(line.product_id) ?? [];
    arr.push(row);
    queueByProduct.set(line.product_id, arr);
  }

  for (const queue of queueByProduct.values()) {
    queue.sort((a, b) => {
      const priorityRank: Record<string, number> = { Critical: 0, High: 1, Normal: 2, Low: 3 };
      const priorityDifference = (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2);
      if (priorityDifference !== 0) return priorityDifference;
      const left = a.position === "—" ? Number.MAX_SAFE_INTEGER : Number(a.position);
      const right = b.position === "—" ? Number.MAX_SAFE_INTEGER : Number(b.position);
      return left - right;
    });
  }

  const coverageQueueByProduct = new Map<string, OpenQueueLine[]>();
  for (const line of dedupedQueueLineRows) {
    if (!line.product_id || !isOpenQueueLine(line)) continue;
    if (manualMappingSkus.has(normalizeSkuKey(line.products?.sku)) || manualMappingSkus.has(normalizeSkuKey(line.legacy_item_code)) || String(line.shipping_orders?.order_number ?? "").trim() === "126037") continue;
    const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    const floorReservedQty = (line.inventory_allocations ?? [])
      .filter((allocation) => (allocation.allocation_status ?? "ALLOCATED") === "ALLOCATED" && allocation.source_type === "FLOOR")
      .reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0);
    const stagedWarehouseQty = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase()) ? remainingQty : 0;
    const rows = coverageQueueByProduct.get(line.product_id) ?? [];
    rows.push({
      id: line.id,
      product_id: line.product_id,
      remaining_qty: remainingQty,
      priority: line.priority,
      queue_position_start: line.queue_position_start,
      approved_at: null,
      created_at: line.shipping_orders?.created_at ?? new Date().toISOString(),
      has_live_allocation: (line.inventory_allocations ?? []).some((allocation) => (allocation.allocation_status ?? "ALLOCATED") === "ALLOCATED"),
      fulfillment_source: line.fulfillment_source,
      warehouse_reserved_qty: Math.max(floorReservedQty, stagedWarehouseQty),
    });
    coverageQueueByProduct.set(line.product_id, rows);
  }

  const coverageContainerSupplyByProduct = new Map<string, ProductContainerSupply[]>();
  for (const line of containerLineRows) {
    if (!line.product_id || !line.container_id || !isActiveIncomingContainer(line.containers?.lifecycle_status)) continue;
    const qty = Math.max(0, Number(line.on_order_qty ?? 0) - Number(line.received_qty ?? 0));
    if (qty <= 0) continue;
    const rows = coverageContainerSupplyByProduct.get(line.product_id) ?? [];
    rows.push({
      container_id: line.container_id,
      container_number: line.containers?.container_number ?? null,
      available_qty: qty,
      eta_confirmed_date: line.containers?.eta_confirmed_date ?? null,
      eta_estimated_date: line.containers?.eta_estimated_date ?? line.containers?.port_date ?? null,
      entered_date: null,
    });
    coverageContainerSupplyByProduct.set(line.product_id, rows);
  }

  const coverageByLineId = new Map<string, LineCoverage>();
  for (const productId of new Set([...coverageQueueByProduct.keys(), ...coverageContainerSupplyByProduct.keys()])) {
    const coverage = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, Math.max(0, onFloorByProduct.get(productId) ?? 0)]]),
      queueLinesByProduct: coverageQueueByProduct,
      containerSupplyByProduct: coverageContainerSupplyByProduct,
    });
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
      incoming: 0,
      availableAfterIncoming: 0,
      backorderedAfterIncoming: 0,
      nextEta: "—",
      incomingContainers: [],
      customerQueue: [],
    };

    group.onFloor += onFloorByProduct.get(product.id) ?? 0;
    group.openDemand += openDemandByProduct.get(product.id) ?? 0;
    group.floorCommitted += floorCommittedByProduct.get(product.id) ?? 0;
    group.customerQueue = [...group.customerQueue, ...(queueByProduct.get(product.id) ?? [])];
    group.productIds = [...group.productIds, product.id];

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
      // Keep each logical product obligation distinct. An invoice can have multiple physical
      // lines, and canonical display groups must never sum unrelated lines into one customer qty.
      const customerDemandByInvoice = new Map<string, (typeof group.customerQueue)[number]>();
      for (const item of group.customerQueue) {
        const key = item.invoice && item.invoice !== "—"
          ? `INVOICE:${item.invoice}|${item.logicalDemandKey}`.toUpperCase()
          : `ORDER:${item.orderId}|${item.logicalDemandKey}`.toUpperCase();
        const existing = customerDemandByInvoice.get(key);
        if (!existing) {
          customerDemandByInvoice.set(key, { ...item });
          continue;
        }
        existing.openQty += item.openQty;
        existing.warehouseQty += item.warehouseQty;
        existing.waitingQty += item.waitingQty;
        existing.inWarehouse = existing.inWarehouse || item.inWarehouse;
        existing.willCall = existing.willCall || item.willCall;
        existing.qty += item.qty;
        existing.approvedQty += item.approvedQty;
        existing.shippedQty += item.shippedQty;
      }
      group.customerQueue = Array.from(customerDemandByInvoice.values());
      group.openDemand = group.customerQueue.reduce((sum, item) => sum + item.openQty, 0);

      // Unallocated open demand still consumes floor stock, matching the OLD_ERP Available = On Floor - Sold rule.
      const committedFloor = Math.max(group.floorCommitted, Math.min(group.openDemand, group.onFloor));
      const incomingContainers = group.incomingContainers
        .slice()
        .sort((left, right) => left.etaSort.localeCompare(right.etaSort));
      const customerQueue = group.customerQueue
        .slice()
        .sort((left, right) => {
          const leftPaymentAt = Date.parse(left.firstPaymentAt ?? "");
          const rightPaymentAt = Date.parse(right.firstPaymentAt ?? "");
          const leftHasPayment = Number.isFinite(leftPaymentAt);
          const rightHasPayment = Number.isFinite(rightPaymentAt);
          if (leftHasPayment !== rightHasPayment) return leftHasPayment ? -1 : 1;
          if (leftHasPayment && leftPaymentAt !== rightPaymentAt) return leftPaymentAt - rightPaymentAt;
          const leftCreatedAt = Date.parse(left.orderCreatedAt ?? "") || Number.MAX_SAFE_INTEGER;
          const rightCreatedAt = Date.parse(right.orderCreatedAt ?? "") || Number.MAX_SAFE_INTEGER;
          if (leftCreatedAt !== rightCreatedAt) return leftCreatedAt - rightCreatedAt;
          const leftPosition = left.position === "—" ? Number.MAX_SAFE_INTEGER : Number(left.position);
          const rightPosition = right.position === "—" ? Number.MAX_SAFE_INTEGER : Number(right.position);
          return leftPosition - rightPosition;
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

      return {
        ...group,
        incomingContainers,
        customerQueue: coveredQueue,
        availableNow: Math.max(0, group.onFloor - committedFloor),
        availableAfterIncoming: Math.max(0, group.onFloor + group.incoming - group.openDemand),
        backorderedAfterIncoming: Math.max(0, group.openDemand - group.onFloor - group.incoming),
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

  const sections: Array<{ name: string; rows: typeof displayRows }> = [];
  for (const row of displayRows) {
    const current = sections[sections.length - 1];
    if (current && current.name === row.group) current.rows.push(row);
    else sections.push({ name: row.group, rows: [row] });
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#6b7280]">Inventory</p>
            <h1 className="mt-1 text-3xl font-semibold text-[#111827]">Lift Availability</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">Search product availability, incoming containers/ETA, and approved customer queue by SKU.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <AdminModeToggle unlocked={adminMode} />
            <Link href="/product-mappings" className="btn-primary">Map Unmapped SKUs</Link>
            <AddProductModal createAction={createProductAction} groups={groupNames.filter((group) => group !== UNSORTED_GROUP)} />
          </div>
        </div>
      </div>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <form className="space-y-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Product lookup</p>
            <label htmlFor="inventory-search" className="mt-1 block text-sm font-semibold text-[#334155]">Find an item by name or SKU</label>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              id="inventory-search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search item name or SKU..."
              className="input min-w-[260px] flex-1 text-base"
            />
            <button className="btn-primary" type="submit">Lookup</button>
            <Link className="btn-ghost" href="/inventory">Clear</Link>
          </div>
        </form>
      </section>

      <nav aria-label="Inventory groups" className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Groups</span>
          {sections.map((section) => (
            <a
              key={section.name}
              href={`#group-${section.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
              className="rounded-full border border-[#dbe3ee] bg-[#f8fafc] px-3 py-1.5 text-xs font-semibold text-[#334155] transition hover:border-[#93c5fd] hover:bg-[#eff6ff]"
            >
              {section.name} <span className="font-normal text-[#64748b]">({section.rows.length})</span>
            </a>
          ))}
        </div>
      </nav>

      {mapError ? <p className="rounded-md border border-[#fecaca] bg-[#fff1f2] p-3 text-sm text-[#991b1b]">{mapError}</p> : null}
      {mapMessage ? <p className="rounded-md border border-[#bbf7d0] bg-[#f0fdf4] p-3 text-sm text-[#166534]">{mapMessage}</p> : null}

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[1080px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[280px]" />
              <col className="w-[82px]" />
              <col className="w-[78px]" />
              <col className="w-[108px]" />
              <col className="w-[92px]" />
              <col className="w-[176px]" />
              <col className="w-[128px]" />
              <col className="w-[156px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-[#eceff3] text-xs uppercase tracking-[0.08em] text-[#64748b]">
                <th className="px-2 py-2.5">Item</th>
                <th className="px-2 py-2.5">On Floor</th>
                <th className="px-2 py-2.5">Sold</th>
                <th className="px-2 py-2.5">Available Now</th>
                <th className="px-2 py-2.5">Incoming</th>
                <th className="px-2 py-2.5">Available/Incoming</th>
                <th className="px-2 py-2.5">Next Arrival</th>
                <th className="px-2 py-2.5">Customer List</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-2 py-10 text-center text-[#6b7280]">No products match this search.</td>
                </tr>
              ) : (
                sections.map((section) => (
                  <Fragment key={section.name}>
                    <tr id={`group-${section.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="scroll-mt-24 border-b border-[#e2e8f0] bg-[#f8fafc]">
                      <th colSpan={8} scope="colgroup" className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#475569]">
                        {section.name}
                        <span className="ml-2 font-normal normal-case tracking-normal text-[#94a3b8]">{section.rows.length}</span>
                      </th>
                    </tr>
                    {section.rows.map((row) => (
                      <tr key={row.productId} className="border-b border-[#f1f5f9] align-top">
                    <td className="px-2 py-3">
                      <div className="line-clamp-2 max-w-[260px] break-words font-semibold leading-5 text-[#111827]" title={row.productName}>{row.productName}</div>
                      <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-[#64748b]">
                        {row.manufacturer ? (
                          <span className="rounded border border-[#e2e8f0] bg-[#f8fafc] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[#475569]">
                            {row.manufacturer}
                          </span>
                        ) : null}
                        <span>SKU {row.sku}</span>
                      </div>
                      {adminMode ? (
                        <AdminRowEditor
                          productId={row.productId}
                          sku={row.sku}
                          productName={row.productName}
                          storedName={row.storedName}
                          onFloor={row.onFloor}
                        />
                      ) : null}
                      <DisplayOrderButton
                        productIds={row.productIds}
                        productName={row.productName}
                        sku={row.sku}
                        group={row.group}
                        sortOrder={row.sortOrder === Number.MAX_SAFE_INTEGER ? null : row.sortOrder}
                        groups={groupNames}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-3">{formatNumber(row.onFloor)}</td>
                    <td className="whitespace-nowrap px-2 py-3">{formatNumber(row.openDemand)}</td>
                    <td className="whitespace-nowrap px-2 py-3 font-semibold text-[#16a34a]">
                      {formatNumber(row.availableNow)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3">
                      <IncomingDropdown
                        total={formatNumber(row.incoming)}
                        containers={row.incomingContainers}
                      />
                    </td>
                    <td className="px-2 py-3">
                      <div className="font-semibold text-[#111827]">{formatNumber(row.availableAfterIncoming)}</div>
                      {row.backorderedAfterIncoming > 0 ? (
                        <div className="mt-1 text-xs font-semibold text-[#b45309]">Backordered {formatNumber(row.backorderedAfterIncoming)}</div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3">{row.nextEta}</td>
                    <td className="whitespace-nowrap px-2 py-3">
                      <CustomerDemandDropdown
                        productName={row.productName}
                        sku={row.sku}
                        openQuantity={formatNumber(row.openDemand)}
                        customerQueue={row.customerQueue}
                        adminMode={adminMode}
                      />
                    </td>
                      </tr>
                    ))}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
