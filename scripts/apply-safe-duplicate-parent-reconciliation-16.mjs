import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PREVIEW_FILE = "tmp/safe-duplicate-parent-reconciliation-preview.json";
const EXPECTED_INVOICES = [
  "11687",
  "11932",
  "12044",
  "12105",
  "12184",
  "12197A",
  "12234A",
  "12396",
  "12402",
  "12414",
  "12429",
  "12587",
  "12589",
  "126086",
  "126098",
  "126161",
].sort();

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const invoiceArg = process.argv.find((arg) => arg.startsWith("--invoice="));
const singleInvoice = invoiceArg ? invoiceArg.split("=")[1]?.trim() : "";
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

function parsePreview() {
  const preview = JSON.parse(fs.readFileSync(PREVIEW_FILE, "utf8"));
  const invoices = (preview.parentsToRetire ?? []).map((row) => String(row.invoice ?? "")).sort();
  if ((preview.parentsToRetire ?? []).length !== 16) {
    throw new Error(`Preview does not contain exactly 16 apply-ready groups (found ${(preview.parentsToRetire ?? []).length}).`);
  }
  if (JSON.stringify(invoices) !== JSON.stringify(EXPECTED_INVOICES)) {
    throw new Error("Preview invoice set differs from the locked 16-group batch. Refusing to broaden scope.");
  }
  return preview;
}

function getSelectedGroups(preview) {
  const groups = preview.parentsToRetire ?? [];
  if (!singleInvoice) return groups;
  if (!EXPECTED_INVOICES.includes(singleInvoice)) {
    throw new Error(`Invoice ${singleInvoice} is not in the locked 16-group batch.`);
  }
  const selected = groups.filter((group) => String(group.invoice) === singleInvoice);
  if (selected.length !== 1) {
    throw new Error(`Could not resolve exactly one group for invoice ${singleInvoice}.`);
  }
  return selected;
}

async function loadAll(table, select, builder = (query) => query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await builder(supabase.from(table).select(select).range(from, from + 999));
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

function number(value) {
  return Number(value ?? 0);
}

function openQty(line) {
  const closedApproval = ["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"];
  const closedFulfillment = ["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"];
  const approved = number(line.approved_qty);
  const fulfilled = number(line.fulfilled_qty);
  if (approved <= fulfilled) return 0;
  if (closedApproval.includes(String(line.approval_status ?? "").toUpperCase())) return 0;
  if (closedFulfillment.includes(String(line.fulfillment_status ?? "").toUpperCase())) return 0;
  return Math.max(0, approved - fulfilled);
}

function queueQty(line) {
  const approval = String(line.approval_status ?? "").toUpperCase();
  const fulfillment = String(line.fulfillment_status ?? "").toUpperCase();
  if (!["APPROVED", "PARTIAL"].includes(approval)) return 0;
  if (["FULFILLED", "CANCELLED"].includes(fulfillment)) return 0;
  return openQty(line);
}

function demandIdentity(line) {
  if (line.qbo_invoice_line_id) return `QBO_LINE:${line.qbo_invoice_line_id}`;
  if (line.source_record_id) return `SOURCE:${line.source_record_id}`;
  return `LINE:${line.id}`;
}

function add(map, key, quantity) {
  map.set(key, (map.get(key) ?? 0) + quantity);
}

async function snapshotInvariants(targetInvoiceIds = null) {
  const [orders, lines, inventoryTransactions, allocations, shipmentLines, containerLines] = await Promise.all([
    loadAll("shipping_orders", "id, source_invoice_id, duplicate_of_order_id, review_status"),
    loadAll("shipping_order_lines", "id, shipping_order_id, product_id, qbo_invoice_line_id, source_record_id, approved_qty, fulfilled_qty, approval_status, fulfillment_status"),
    loadAll("inventory_transactions", "bucket, delta"),
    loadAll("inventory_allocations", "quantity"),
    loadAll("order_shipment_lines", "quantity"),
    loadAll("container_lines", "on_order_qty, received_qty"),
  ]);

  const orderById = new Map(orders.map((row) => [row.id, row]));
  const activeLines = lines.filter((line) => {
    const parent = orderById.get(line.shipping_order_id);
    if (!parent || parent.duplicate_of_order_id) return false;
    if (targetInvoiceIds && !targetInvoiceIds.has(parent.source_invoice_id)) return false;
    return true;
  });

  const byIdentity = new Map();
  for (const line of activeLines) {
    const key = demandIdentity(line);
    const existing = byIdentity.get(key);
    if (!existing || openQty(line) > openQty(existing)) byIdentity.set(key, line);
  }

  const dedupedLines = Array.from(byIdentity.values());
  const activeDemand = dedupedLines.reduce((sum, line) => sum + openQty(line), 0);
  const queueDemand = dedupedLines.reduce((sum, line) => sum + queueQty(line), 0);
  const fulfilledQty = lines.reduce((sum, line) => sum + number(line.fulfilled_qty), 0);

  const inventoryByBucket = inventoryTransactions.reduce((acc, row) => {
    const bucket = String(row.bucket ?? "UNKNOWN");
    acc[bucket] = (acc[bucket] ?? 0) + number(row.delta);
    return acc;
  }, {});

  const activeParentCount = orders.filter((order) => !order.duplicate_of_order_id && (!targetInvoiceIds || targetInvoiceIds.has(order.source_invoice_id))).length;

  return {
    activeDemand,
    queueDemand,
    fulfilledQty,
    inventoryByBucket,
    allocationQty: allocations.reduce((sum, row) => sum + number(row.quantity), 0),
    shipmentQty: shipmentLines.reduce((sum, row) => sum + number(row.quantity), 0),
    containerOnOrderQty: containerLines.reduce((sum, row) => sum + number(row.on_order_qty), 0),
    containerReceivedQty: containerLines.reduce((sum, row) => sum + number(row.received_qty), 0),
    activeParentCount,
  };
}

function invariantsDiff(before, after) {
  const keys = [
    "activeDemand",
    "queueDemand",
    "fulfilledQty",
    "allocationQty",
    "shipmentQty",
    "containerOnOrderQty",
    "containerReceivedQty",
    "activeParentCount",
  ];
  const diff = Object.fromEntries(keys.map((key) => [key, number(after[key]) - number(before[key])]));
  const bucketKeys = new Set([...Object.keys(before.inventoryByBucket), ...Object.keys(after.inventoryByBucket)]);
  diff.inventoryByBucket = Object.fromEntries([...bucketKeys].map((bucket) => [bucket, number(after.inventoryByBucket[bucket]) - number(before.inventoryByBucket[bucket])]))
  return diff;
}

async function recalculateQueuePositions(productIds) {
  const uniqueProductIds = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueProductIds.length === 0) return { productsUpdated: 0, linesUpdated: 0 };

  const { error: firstPaymentColumnError } = await supabase.from("shipping_orders").select("first_payment_at").limit(1);
  const paymentField = firstPaymentColumnError ? "" : ", first_payment_at";
  const { error: duplicateParentColumnError } = await supabase.from("shipping_orders").select("duplicate_of_order_id").limit(1);
  const duplicateField = duplicateParentColumnError ? "" : ", duplicate_of_order_id";

  const allRows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from("shipping_order_lines")
      .select(`id, product_id, approved_qty, fulfilled_qty, approval_status, fulfillment_status, queue_position_override, queue_position_start, queue_position_count, shipping_orders(created_at${paymentField}${duplicateField})`)
      .in("product_id", uniqueProductIds)
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`queue-read: ${error.message}`);
    allRows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  function isActive(line) {
    if (line.shipping_orders?.duplicate_of_order_id) return false;
    const approval = String(line.approval_status ?? "").toUpperCase();
    const fulfillment = String(line.fulfillment_status ?? "").toUpperCase();
    return Boolean(line.product_id) && ["APPROVED", "PARTIAL"].includes(approval) && !["FULFILLED", "CANCELLED"].includes(fulfillment);
  }

  function compare(left, right) {
    const leftOverride = Number(left.queue_position_override);
    const rightOverride = Number(right.queue_position_override);
    const hasLeftOverride = Number.isFinite(leftOverride) && leftOverride > 0;
    const hasRightOverride = Number.isFinite(rightOverride) && rightOverride > 0;
    if (hasLeftOverride || hasRightOverride) {
      if (!hasLeftOverride) return 1;
      if (!hasRightOverride) return -1;
      if (leftOverride !== rightOverride) return leftOverride - rightOverride;
    }

    const leftPaymentDate = Date.parse(String(left.shipping_orders?.first_payment_at ?? ""));
    const rightPaymentDate = Date.parse(String(right.shipping_orders?.first_payment_at ?? ""));
    const leftHasPayment = Number.isFinite(leftPaymentDate);
    const rightHasPayment = Number.isFinite(rightPaymentDate);
    if (leftHasPayment !== rightHasPayment) return leftHasPayment ? -1 : 1;
    if (leftHasPayment && leftPaymentDate !== rightPaymentDate) return leftPaymentDate - rightPaymentDate;

    const leftDate = Date.parse(String(left.shipping_orders?.created_at ?? "")) || Number.MAX_SAFE_INTEGER;
    const rightDate = Date.parse(String(right.shipping_orders?.created_at ?? "")) || Number.MAX_SAFE_INTEGER;
    if (leftDate !== rightDate) return leftDate - rightDate;
    return String(left.id).localeCompare(String(right.id));
  }

  const byProduct = new Map();
  for (const row of allRows) {
    if (!isActive(row) || !row.product_id) continue;
    const list = byProduct.get(row.product_id) ?? [];
    list.push(row);
    byProduct.set(row.product_id, list);
  }

  let linesUpdated = 0;
  for (const productId of uniqueProductIds) {
    const lines = (byProduct.get(productId) ?? []).sort(compare);
    let position = 1;

    for (const line of lines) {
      const units = Math.max(0, number(line.approved_qty) - number(line.fulfilled_qty));
      if (units <= 0) continue;

      if (number(line.queue_position_start) !== position || number(line.queue_position_count) !== units) {
        const { error } = await supabase
          .from("shipping_order_lines")
          .update({ queue_position_start: position, queue_position_count: units })
          .eq("id", line.id);
        if (error) throw new Error(`queue-update(${line.id}): ${error.message}`);
        linesUpdated += 1;
      }

      position += units;
    }

    const inactiveLines = allRows.filter((line) => line.product_id === productId && !isActive(line) && line.queue_position_start != null);
    for (const line of inactiveLines) {
      const { error } = await supabase
        .from("shipping_order_lines")
        .update({ queue_position_start: null, queue_position_count: null })
        .eq("id", line.id);
      if (error) throw new Error(`queue-clear(${line.id}): ${error.message}`);
    }
  }

  return { productsUpdated: uniqueProductIds.length, linesUpdated };
}

async function reconcileGroup(preview, group, dryRun, reviewLog) {
  const invoice = String(group.invoice);
  const sourceInvoiceId = String(group.sourceInvoiceId);
  const canonicalOrderId = String(group.canonicalOrderId);
  const retiredOrderIds = new Set((group.retiredOrderIds ?? []).map(String));
  const linePlan = (preview.sameObligationLines ?? []).filter((line) => String(line.invoice) === invoice);

  const { data: liveParents, error: liveParentError } = await supabase
    .from("shipping_orders")
    .select("id, source_invoice_id, duplicate_of_order_id, source_type")
    .eq("source_invoice_id", sourceInvoiceId);
  if (liveParentError) {
    reviewLog.push({ invoice, reason: `Parent read failed: ${liveParentError.message}` });
    return { applied: false, skipped: true, productIds: [] };
  }

  const activeParents = (liveParents ?? []).filter((row) => !row.duplicate_of_order_id).map((row) => row.id);
  if (!activeParents.includes(canonicalOrderId)) {
    reviewLog.push({ invoice, reason: "Canonical parent is missing or already retired" });
    return { applied: false, skipped: true, productIds: [] };
  }

  for (const oldParentId of retiredOrderIds) {
    if (!activeParents.includes(oldParentId)) {
      reviewLog.push({ invoice, reason: `Old parent ${oldParentId} is missing or already retired` });
      return { applied: false, skipped: true, productIds: [] };
    }
  }

  for (const line of linePlan) {
    const { data: oldLine, error: oldLineError } = await supabase
      .from("shipping_order_lines")
      .select("id, shipping_order_id, product_id, qbo_invoice_line_id, source_system, source_record_id, source_key, legacy_item_code, approved_qty, fulfilled_qty, ordered_qty, approval_status, fulfillment_status")
      .eq("id", line.oldLineId)
      .maybeSingle();
    if (oldLineError || !oldLine) {
      reviewLog.push({ invoice, reason: `OLD_ERP line read failed for ${line.oldLineId}` });
      return { applied: false, skipped: true, productIds: [] };
    }

    if (String(oldLine.shipping_order_id) !== String(line.oldParentId)) {
      reviewLog.push({ invoice, reason: `OLD_ERP line ${line.oldLineId} moved unexpectedly` });
      return { applied: false, skipped: true, productIds: [] };
    }

    if (number(oldLine.approved_qty) !== number(line.oldQuantity?.approved)
      || number(oldLine.fulfilled_qty) !== number(line.oldQuantity?.fulfilled)
      || number(oldLine.ordered_qty) !== number(line.oldQuantity?.ordered)) {
      reviewLog.push({ invoice, reason: `OLD_ERP line ${line.oldLineId} quantity changed since preview` });
      return { applied: false, skipped: true, productIds: [] };
    }

    if (line.operation === "MERGE_INTO_EXISTING_QBO_LINE") {
      const { data: canonicalLine, error: canonicalLineError } = await supabase
        .from("shipping_order_lines")
        .select("id, shipping_order_id, product_id, approved_qty, fulfilled_qty, ordered_qty, source_system, source_record_id, source_key, legacy_item_code")
        .eq("id", line.canonicalLineId)
        .maybeSingle();
      if (canonicalLineError || !canonicalLine) {
        reviewLog.push({ invoice, reason: `Canonical line ${line.canonicalLineId} missing for merge` });
        return { applied: false, skipped: true, productIds: [] };
      }
      if (String(canonicalLine.shipping_order_id) !== canonicalOrderId) {
        reviewLog.push({ invoice, reason: `Canonical line ${line.canonicalLineId} moved unexpectedly` });
        return { applied: false, skipped: true, productIds: [] };
      }
      if (number(canonicalLine.approved_qty) !== number(line.canonicalQuantity?.approved)
        || number(canonicalLine.fulfilled_qty) !== number(line.canonicalQuantity?.fulfilled)
        || number(canonicalLine.ordered_qty) !== number(line.canonicalQuantity?.ordered)) {
        reviewLog.push({ invoice, reason: `Canonical line ${line.canonicalLineId} quantity changed since preview` });
        return { applied: false, skipped: true, productIds: [] };
      }
    }
  }

  if (dryRun) {
    return { applied: false, skipped: false, productIds: linePlan.map((line) => line.productId) };
  }

  for (const line of linePlan) {
    if (line.operation === "MOVE_EXISTING_OLD_LINE") {
      const payload = {
        shipping_order_id: canonicalOrderId,
        qbo_invoice_line_id: line.canonicalQboLineId,
      };
      const { error } = await supabase
        .from("shipping_order_lines")
        .update(payload)
        .eq("id", line.oldLineId)
        .eq("shipping_order_id", line.oldParentId);
      if (error) {
        reviewLog.push({ invoice, reason: `Move failed for ${line.oldLineId}: ${error.message}` });
        return { applied: false, skipped: true, productIds: [] };
      }
    }

    if (line.operation === "MERGE_INTO_EXISTING_QBO_LINE") {
      const provenance = line.provenance ?? {};
      const { data: canonicalBefore, error: canonicalReadError } = await supabase
        .from("shipping_order_lines")
        .select("id, source_system, source_record_id, source_key, legacy_item_code")
        .eq("id", line.canonicalLineId)
        .maybeSingle();
      if (canonicalReadError || !canonicalBefore) {
        reviewLog.push({ invoice, reason: `Canonical provenance read failed for ${line.canonicalLineId}` });
        return { applied: false, skipped: true, productIds: [] };
      }

      // Preserve canonical unique source_key and store OLD_ERP provenance in audit details only.
      const { error: auditError } = await supabase.from("audit_log").insert({
        entity_type: "shipping_order_line",
        entity_id: line.canonicalLineId,
        action: "DUPLICATE_PARENT_PROVENANCE_CAPTURED",
        details: {
          invoice,
          canonicalOrderId,
          oldParentId: line.oldParentId,
          oldLineId: line.oldLineId,
          canonicalQboLineId: line.canonicalQboLineId,
          mode: "SAFE_16_BATCH",
          canonicalPreserved: {
            source_system: canonicalBefore.source_system,
            source_record_id: canonicalBefore.source_record_id,
            source_key: canonicalBefore.source_key,
            legacy_item_code: canonicalBefore.legacy_item_code,
          },
          oldErpProvenance: {
            source_system: provenance.source_system ?? null,
            source_record_id: provenance.source_record_id ?? null,
            source_key: provenance.source_key ?? null,
            legacy_item_code: provenance.legacy_item_code ?? null,
          },
        },
      });
      if (auditError) {
        reviewLog.push({ invoice, reason: `Provenance audit write failed for ${line.canonicalLineId}: ${auditError.message}` });
        return { applied: false, skipped: true, productIds: [] };
      }
    }
  }

  for (const oldParentId of retiredOrderIds) {
    const { error } = await supabase
      .from("shipping_orders")
      .update({ duplicate_of_order_id: canonicalOrderId })
      .eq("id", oldParentId)
      .is("duplicate_of_order_id", null);
    if (error) {
      reviewLog.push({ invoice, reason: `Retire parent failed for ${oldParentId}: ${error.message}` });
      return { applied: false, skipped: true, productIds: [] };
    }

    await supabase.from("audit_log").insert({
      entity_type: "shipping_order",
      entity_id: oldParentId,
      action: "DUPLICATE_PARENT_RETIRED",
      details: {
        canonicalOrderId,
        invoice,
        sourceInvoiceId,
        mode: "SAFE_16_BATCH",
      },
    });
  }

  return { applied: true, skipped: false, productIds: linePlan.map((line) => line.productId) };
}

async function main() {
  const preview = parsePreview();
  const selectedGroups = getSelectedGroups(preview);
  const targetInvoices = new Set(selectedGroups.map((row) => row.sourceInvoiceId));
  const baselineGlobal = await snapshotInvariants(null);
  const baselineTarget = await snapshotInvariants(targetInvoices);
  const reviewLog = [];
  const appliedInvoices = [];
  const skippedInvoices = [];
  const affectedProducts = new Set();

  for (const group of selectedGroups) {
    const groupBefore = await snapshotInvariants(null);
    const result = await reconcileGroup(preview, group, !apply, reviewLog);
    if (result.skipped) {
      skippedInvoices.push(group.invoice);
      continue;
    }
    for (const productId of result.productIds) if (productId) affectedProducts.add(productId);
    if (result.applied) {
      const groupAfter = await snapshotInvariants(null);
      const diff = invariantsDiff(groupBefore, groupAfter);
      const groupChanged = Object.entries(diff).some(([key, value]) => {
        if (key === "activeParentCount") return value !== -1;
        if (key === "inventoryByBucket") return Object.values(value).some((bucketDelta) => bucketDelta !== 0);
        return value !== 0;
      });
      if (groupChanged) {
        reviewLog.push({ invoice: group.invoice, reason: "Invariant changed after apply; group requires manual review", diff });
        skippedInvoices.push(group.invoice);
      } else {
        appliedInvoices.push(group.invoice);
      }
    }
  }

  if (apply && affectedProducts.size > 0) {
    await recalculateQueuePositions([...affectedProducts]);
  }

  const finalGlobal = await snapshotInvariants(null);
  const finalTarget = await snapshotInvariants(targetInvoices);
  const globalDiff = invariantsDiff(baselineGlobal, finalGlobal);
  const targetDiff = invariantsDiff(baselineTarget, finalTarget);

  const noDuplicateActiveByInvoice = await Promise.all(selectedGroups.map(async (group) => {
    const { data, error } = await supabase
      .from("shipping_orders")
      .select("id")
      .eq("source_invoice_id", group.sourceInvoiceId)
      .is("duplicate_of_order_id", null);
    if (error) throw new Error(`Active parent verification failed for invoice ${group.invoice}: ${error.message}`);
    return { invoice: group.invoice, activeParents: (data ?? []).length };
  }));

  const output = {
    mode: apply ? "APPLY" : "DRY_RUN",
    lockedBatchInvoices: EXPECTED_INVOICES,
    requestedBatchCount: selectedGroups.length,
    selectedInvoice: singleInvoice || null,
    appliedCount: appliedInvoices.length,
    skippedCount: skippedInvoices.length,
    appliedInvoices,
    skippedInvoices,
    affectedProducts: [...affectedProducts].sort(),
    globalBefore: baselineGlobal,
    globalAfter: finalGlobal,
    globalDiff,
    targetBefore: baselineTarget,
    targetAfter: finalTarget,
    targetDiff,
    activeParentVerification: noDuplicateActiveByInvoice,
    reviewLog,
  };

  fs.writeFileSync("tmp/apply-safe-duplicate-parent-reconciliation-16-result.json", JSON.stringify(output, null, 2));
  console.log(JSON.stringify({
    mode: output.mode,
    requestedBatchCount: output.requestedBatchCount,
    appliedCount: output.appliedCount,
    skippedCount: output.skippedCount,
    affectedProductCount: output.affectedProducts.length,
    globalDiff: output.globalDiff,
    targetDiff: output.targetDiff,
    resultFile: "tmp/apply-safe-duplicate-parent-reconciliation-16-result.json",
  }, null, 2));
}

await main();
