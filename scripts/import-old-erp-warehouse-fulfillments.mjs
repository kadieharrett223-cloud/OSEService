#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeEmail,
  normalizePhone,
  normalizeSku,
  normalizeText,
  pickFirst,
  timestampSlug,
  toNumber,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

const SOURCE_SYSTEM = "OLD_ERP";

function parseArgs(argv) {
  const args = { exportsDir: "tmp/exports", warehouseFile: "", apply: false, reportOut: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--exports-dir") { args.exportsDir = String(argv[i + 1] ?? "").trim() || args.exportsDir; i += 1; }
    if (token === "--warehouse-file") { args.warehouseFile = String(argv[i + 1] ?? "").trim(); i += 1; }
    if (token === "--apply") args.apply = true;
    if (token === "--report-out") { args.reportOut = String(argv[i + 1] ?? "").trim(); i += 1; }
  }
  return args;
}

function recordStatus(record) {
  return String(record?.status ?? "").trim().toUpperCase();
}

function isFulfilledWarehouseRecord(record) {
  const status = recordStatus(record);
  return status === "SHIPPED" || status === "COMPLETED" || Boolean(record?.shippedAt || record?.completedAt);
}

function sourceLines(record) {
  const lines = Array.isArray(record?.lines) ? record.lines : [];
  return lines.map((line) => ({
    sourceLineId: normalizeText(line?.queueItemId ?? line?.id),
    sku: normalizeSku(pickFirst(line, ["itemCode", "originalItemCode", "sku", "partNumber"])),
    qty: Number(toNumber(pickFirst(line, ["qty", "quantity", "qtyRequired"])) ?? 0),
    scannedQty: Number(toNumber(pickFirst(line, ["qtyScanned", "fulfilledQty", "quantityScanned"])) ?? 0),
    notes: normalizeText(line?.notes),
  })).filter((line) => line.sku && line.qty > 0);
}

function customerFromRecord(record) {
  const name = normalizeText(record?.customerName);
  return {
    full_name: name || "Warehouse Customer Pending",
    company_name: name,
    email: normalizeEmail(record?.qboEmail),
    phone: normalizePhone(record?.qboPhone),
    shipping_address: normalizeText(record?.qboShipAddress),
    quickbooks_customer_id: normalizeText(record?.qboCustomerId ?? record?.quickbooksCustomerId),
  };
}

async function loadRows(supabase, table, select) {
  const { data, error } = await supabase.from(table).select(select);
  if (error) fail(`Could not read ${table}: ${error.message}`);
  return data ?? [];
}

function buildProductMap(products, aliases) {
  const map = new Map();
  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (sku) map.set(sku, product.id);
  }
  for (const alias of aliases) {
    const value = normalizeSku(alias.alias);
    if (value) map.set(value, alias.product_id);
  }
  return map;
}

function indexCustomerRows(customers) {
  const byQbo = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  const byName = new Map();
  for (const row of customers) {
    if (row.quickbooks_customer_id) byQbo.set(String(row.quickbooks_customer_id).trim(), row);
    if (row.email) byEmail.set(normalizeEmail(row.email), row);
    if (row.phone) byPhone.set(normalizePhone(row.phone), row);
    if (row.full_name) byName.set(String(row.full_name).trim().toLowerCase(), row);
    if (row.company_name) byName.set(String(row.company_name).trim().toLowerCase(), row);
  }
  return { byQbo, byEmail, byPhone, byName };
}

function resolveCustomer(customer, indexes) {
  if (customer.quickbooks_customer_id && indexes.byQbo.get(customer.quickbooks_customer_id)) return indexes.byQbo.get(customer.quickbooks_customer_id);
  if (customer.email && indexes.byEmail.get(customer.email)) return indexes.byEmail.get(customer.email);
  if (customer.phone && indexes.byPhone.get(customer.phone)) return indexes.byPhone.get(customer.phone);
  if (customer.full_name && indexes.byName.get(customer.full_name.toLowerCase())) return indexes.byName.get(customer.full_name.toLowerCase());
  return null;
}

function buildPlan(records, products, aliases, customers, orders, lines) {
  const productMap = buildProductMap(products, aliases);
  const customerIndexes = indexCustomerRows(customers);
  const orderByNumber = new Map(orders.map((row) => [String(row.order_number ?? "").trim(), row]));
  const lineByOrderProduct = new Map();
  for (const line of lines) {
    if (line.shipping_order_id && line.product_id) lineByOrderProduct.set(`${line.shipping_order_id}|${line.product_id}`, line);
  }

  const customerPlans = new Map();
  const orderCustomerLinks = [];
  const fulfillmentPlans = [];
  const exceptions = [];

  for (const record of records) {
    const invoice = normalizeText(record?.invoiceNumber);
    if (!invoice) { exceptions.push({ sourceId: record?.id, issue: "MISSING_INVOICE" }); continue; }
    const order = orderByNumber.get(invoice);
    const customer = customerFromRecord(record);
    if (!order) {
      exceptions.push({ sourceId: record?.id, invoice, issue: "MISSING_OLD_ERP_ORDER" });
      continue;
    }

    let existingCustomer = resolveCustomer(customer, customerIndexes);

    if (!existingCustomer) {
      const key = [customer.quickbooks_customer_id ?? "", customer.email ?? "", customer.phone ?? "", customer.full_name].join("|");
      if (!customerPlans.has(key)) customerPlans.set(key, { ...customer, planKey: key });
      existingCustomer = { id: `planned:${key}` };
    }

    if (existingCustomer.id && !existingCustomer.id.startsWith("planned:")) {
      orderCustomerLinks.push({ orderId: order.id, customerId: existingCustomer.id });
    } else {
      orderCustomerLinks.push({ orderId: order.id, customerPlanKey: existingCustomer.id.slice("planned:".length) });
    }

    if (!isFulfilledWarehouseRecord(record)) continue;
    for (const line of sourceLines(record)) {
      const productId = productMap.get(line.sku);
      if (!productId) { exceptions.push({ sourceId: record?.id, invoice, sku: line.sku, issue: "UNMAPPED_PRODUCT" }); continue; }
      const targetLine = lineByOrderProduct.get(`${order.id}|${productId}`);
      if (!targetLine) { exceptions.push({ sourceId: record?.id, invoice, sku: line.sku, issue: "MISSING_TARGET_ORDER_LINE" }); continue; }
      const fulfilledQty = line.scannedQty > 0 ? line.scannedQty : line.qty;
      fulfillmentPlans.push({
        shippingOrderLineId: targetLine.id,
        fulfilledQty,
        sourceEventKey: `OLD_ERP_WAREHOUSE:${record.id}:${line.sourceLineId ?? line.sku}`,
        fulfilledAt: record.shippedAt ?? record.completedAt ?? record.updatedAt ?? record.createdAt ?? null,
        trackingNumber: normalizeText(record?.trackingNumber),
        carrier: normalizeText(record?.trackingCarrier),
        reason: `Imported warehouse status ${recordStatus(record)}`,
      });
    }
  }

  return {
    customerPlans: Array.from(customerPlans.values()),
    orderCustomerLinks,
    fulfillmentPlans,
    exceptions,
    summary: {
      sourceRecords: records.length,
      fulfilledWarehouseRecords: records.filter(isFulfilledWarehouseRecord).length,
      customerPlans: customerPlans.size,
      orderCustomerLinks: orderCustomerLinks.length,
      fulfillmentPlans: fulfillmentPlans.length,
      exceptionCount: exceptions.length,
      unmappedProductCount: exceptions.filter((row) => row.issue === "UNMAPPED_PRODUCT").length,
      missingOrderCount: exceptions.filter((row) => row.issue === "MISSING_OLD_ERP_ORDER").length,
      missingLineCount: exceptions.filter((row) => row.issue === "MISSING_TARGET_ORDER_LINE").length,
    },
  };
}

async function applyPlan(supabase, plan) {
  const customerResults = { inserted: 0, matched: 0 };
  const customerByKey = new Map();

  for (const customer of plan.customerPlans) {
    const { data: existing } = await supabase.from("customers").select("id").or(`full_name.ilike.${customer.full_name},company_name.ilike.${customer.company_name ?? customer.full_name}`).limit(1).maybeSingle();
    if (existing?.id) { customerByKey.set(customer.full_name, existing.id); customerResults.matched += 1; continue; }
    const { planKey: _planKey, ...customerPayload } = customer;
    const { data, error } = await supabase.from("customers").insert(customerPayload).select("id").single();
    if (error) fail(`Could not insert warehouse customer ${customer.full_name}: ${error.message}`);
    customerByKey.set(customer.planKey, data.id);
    customerResults.inserted += 1;
  }

  let ordersLinked = 0;
  for (const link of plan.orderCustomerLinks) {
    const customerId = link.customerId ?? customerByKey.get(link.customerPlanKey);
    if (!customerId) continue;
    const { error } = await supabase.from("shipping_orders").update({ customer_id: customerId }).eq("id", link.orderId).eq("source_system", SOURCE_SYSTEM);
    if (error) fail(`Could not link warehouse customer to order ${link.orderId}: ${error.message}`);
    ordersLinked += 1;
  }

  let fulfillmentsUpserted = 0;
  for (const fulfillment of plan.fulfillmentPlans) {
    const { error } = await supabase.from("fulfillments").upsert({
      shipping_order_line_id: fulfillment.shippingOrderLineId,
      fulfilled_qty: fulfillment.fulfilledQty,
      fulfilled_at: fulfillment.fulfilledAt,
      tracking_number: fulfillment.trackingNumber,
      carrier: fulfillment.carrier,
      reason: fulfillment.reason,
      source_event_key: fulfillment.sourceEventKey,
    }, { onConflict: "shipping_order_line_id,source_event_key" });
    if (error) fail(`Could not upsert warehouse fulfillment ${fulfillment.sourceEventKey}: ${error.message}`);
    fulfillmentsUpserted += 1;
  }

  return { customerResults, ordersLinked, fulfillmentsUpserted };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadCosmosSources({ exportsDir: args.exportsDir, explicitFiles: { WarehouseInvoices: args.warehouseFile } });
  const supabase = createSupabaseAdminClient();
  const [products, aliases, customers, orders, lines] = await Promise.all([
    loadRows(supabase, "products", "id, sku"),
    loadRows(supabase, "product_aliases", "product_id, alias"),
    loadRows(supabase, "customers", "id, full_name, company_name, email, phone, quickbooks_customer_id"),
    loadRows(supabase, "shipping_orders", "id, order_number, customer_id, source_system"),
    loadRows(supabase, "shipping_order_lines", "id, shipping_order_id, product_id"),
  ]);
  const oldOrders = orders.filter((row) => row.source_system === SOURCE_SYSTEM);
  const oldLines = lines;
  const plan = buildPlan(sources.warehouseInvoices, products, aliases, customers, oldOrders, oldLines);
  const report = { generatedAt: new Date().toISOString(), mode: args.apply ? "apply" : "preview", sourceFile: sources.files.WarehouseInvoices, summary: plan.summary, exceptions: plan.exceptions.slice(0, 500), sampleFulfillments: plan.fulfillmentPlans.slice(0, 50) };
  if (args.apply) report.applyResults = await applyPlan(supabase, plan);
  const reportPath = args.reportOut ? path.resolve(args.reportOut) : path.resolve(`tmp/import-reports/old-erp-warehouse-fulfillments-${timestampSlug()}.json`);
  const resolved = writeJsonFile(reportPath, report);
  console.log("\n=== OLD_ERP Warehouse Fulfillment Import ===\n");
  console.log(report.summary);
  if (report.applyResults) console.log("Apply results:", report.applyResults);
  console.log(`Report: ${resolved}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown warehouse import failure"));
