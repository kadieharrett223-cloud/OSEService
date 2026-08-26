#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  normalizeSku,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

const CUTOFF = "2026-08-07T00:00:00.000Z";
const PAID_STATUSES = new Set(["Paid", "Partially Paid"]);
const TERMINAL_FULFILLMENT_STATUSES = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);
const ACTIVE_APPROVAL_STATUSES = new Set(["APPROVED", "PARTIAL"]);
const QBO_TOKEN_URL = "https://quickbooks.api.intuit.com";
const QBO_SANDBOX_URL = "https://sandbox-quickbooks.api.intuit.com";
const QBO_OAUTH_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function readEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function decryptToken(payload) {
  const [ivValue, tagValue, encryptedValue] = String(payload ?? "").split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("QuickBooks access token is invalid. Run a normal QuickBooks sync, then retry the preview.");

  const secret = readEnv("QUICKBOOKS_TOKEN_ENCRYPTION_KEY") || readEnv("APP_SESSION_SECRET");
  if (!secret) throw new Error("Missing QuickBooks token encryption key.");

  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

async function loadAll(supabase, table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

async function queryQuickBooks(connection, accessToken, query) {
  const apiBase = connection.environment === "sandbox" ? QBO_SANDBOX_URL : QBO_TOKEN_URL;
  const response = await fetch(
    `${apiBase}/v3/company/${encodeURIComponent(connection.realm_id)}/query?query=${encodeURIComponent(query)}&minorversion=75`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.Fault?.Error?.[0]?.Detail ?? payload?.Fault?.Error?.[0]?.Message ?? `QuickBooks query failed with status ${response.status}.`;
    throw new Error(String(detail));
  }
  return payload ?? {};
}

async function loadFirstPayments(connection) {
  const expiresAt = Date.parse(String(connection.access_token_expires_at ?? ""));
  if (!Number.isFinite(expiresAt) || expiresAt - Date.now() < 60_000) {
    throw new Error("QuickBooks access token is expired. Run a normal QuickBooks sync, then rerun this strictly read-only preview within the access-token window.");
  }
  const accessToken = decryptToken(connection.encrypted_access_token);
  const firstPaymentByQboInvoiceId = new Map();
  for (let page = 0; page < 50; page += 1) {
    const payload = await queryQuickBooks(connection, accessToken, `select * from Payment startposition ${page * 200 + 1} maxresults 200`);
    const payments = payload?.QueryResponse?.Payment ?? [];
    if (!Array.isArray(payments) || payments.length === 0) break;

    for (const payment of payments) {
      const paymentDate = typeof payment?.TxnDate === "string" ? payment.TxnDate : null;
      if (!paymentDate || Number.isNaN(Date.parse(paymentDate))) continue;
      for (const paymentLine of Array.isArray(payment?.Line) ? payment.Line : []) {
        for (const transaction of Array.isArray(paymentLine?.LinkedTxn) ? paymentLine.LinkedTxn : []) {
          if (transaction?.TxnType !== "Invoice" || typeof transaction?.TxnId !== "string") continue;
          const prior = firstPaymentByQboInvoiceId.get(transaction.TxnId);
          if (!prior || Date.parse(paymentDate) < Date.parse(prior)) firstPaymentByQboInvoiceId.set(transaction.TxnId, paymentDate);
        }
      }
    }
    if (payments.length < 200) break;
  }
  return firstPaymentByQboInvoiceId;
}

function isVoided(invoice) {
  const raw = invoice.raw_payload ?? {};
  return invoice.payment_status === "Voided"
    || String(raw.PrivateNote ?? "").trim().toUpperCase() === "VOIDED"
    || String(raw.TxnStatus ?? raw.status ?? "").trim().toUpperCase() === "VOIDED";
}

function isNonPhysicalLine(line) {
  const text = `${line.qbo_sku ?? ""} ${line.source_description ?? ""}`.toLowerCase();
  return /^note\b/.test(text)
    || /discount|shipping|freight|delivery|sales tax|tax adjustment|\bservice\b|\binstall(?:ation)?\b/.test(text);
}

function normalizedText(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

function sameText(left, right) {
  const leftValue = normalizedText(left);
  const rightValue = normalizedText(right);
  return Boolean(leftValue) && leftValue === rightValue;
}

function remainingDemand(line) {
  return Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
}

function isActiveDemand(line) {
  return ACTIVE_APPROVAL_STATUSES.has(normalizedText(line.approval_status))
    && !TERMINAL_FULFILLMENT_STATUSES.has(normalizedText(line.fulfillment_status))
    && remainingDemand(line) > 0;
}

function isTerminalLine(line) {
  return TERMINAL_FULFILLMENT_STATUSES.has(normalizedText(line.fulfillment_status))
    || Number(line.fulfilled_qty ?? 0) >= Number(line.ordered_qty ?? line.approved_qty ?? 0) && Number(line.ordered_qty ?? line.approved_qty ?? 0) > 0;
}

function buildProductMap(products, aliases) {
  const map = new Map();
  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (sku) map.set(sku, product.id);
  }
  for (const alias of aliases) {
    const sku = normalizeSku(alias.alias);
    if (sku) map.set(sku, alias.product_id);
  }
  return map;
}

async function main() {
  const supabase = createSupabaseAdminClient();
  const [connections, invoices, invoiceLines, orders, orderLines, products, aliases, resolutions] = await Promise.all([
    supabase.from("quickbooks_connections").select("id,realm_id,environment,status,encrypted_access_token,encrypted_refresh_token,access_token_expires_at,updated_at").eq("status", "connected").order("updated_at", { ascending: false }).limit(1),
    loadAll(supabase, "qbo_invoices", "id,qbo_invoice_id,invoice_number,invoice_date,payment_status,customer_id,raw_payload,customers(company_name,full_name)"),
    loadAll(supabase, "qbo_invoice_lines", "id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty,product_id"),
    loadAll(supabase, "shipping_orders", "id,source_invoice_id,source_type,duplicate_of_order_id,cancellation_status,order_number,customer_id,legacy_customer_name,customers(company_name,full_name)"),
    loadAll(supabase, "shipping_order_lines", "id,shipping_order_id,qbo_invoice_line_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,legacy_item_code,products(sku)"),
    loadAll(supabase, "products", "id,sku"),
    loadAll(supabase, "product_aliases", "product_id,alias"),
    loadAll(supabase, "reviewed_obligation_resolutions", "qbo_invoice_line_id,resolution_type,status,resolution_note"),
  ]);

  if (connections.error) throw new Error(connections.error.message);
  const connection = connections.data?.[0];
  if (!connection) throw new Error("QuickBooks is not connected.");

  const firstPaymentByQboInvoiceId = await loadFirstPayments(connection);
  const linesByInvoice = new Map();
  for (const line of invoiceLines) {
    const lines = linesByInvoice.get(line.qbo_invoice_id) ?? [];
    lines.push(line);
    linesByInvoice.set(line.qbo_invoice_id, lines);
  }
  const ordersByInvoice = new Map();
  for (const order of orders) {
    if (!order.source_invoice_id) continue;
    const matches = ordersByInvoice.get(order.source_invoice_id) ?? [];
    matches.push(order);
    ordersByInvoice.set(order.source_invoice_id, matches);
  }

  const linesByOrder = new Map();
  for (const line of orderLines) {
    const lines = linesByOrder.get(line.shipping_order_id) ?? [];
    lines.push(line);
    linesByOrder.set(line.shipping_order_id, lines);
  }
  const activeResolutionsByQboLineId = new Map(
    resolutions
      .filter((resolution) => normalizedText(resolution.status) === "ACTIVE" && resolution.qbo_invoice_line_id)
      .map((resolution) => [String(resolution.qbo_invoice_line_id), resolution]),
  );

  const productMap = buildProductMap(products, aliases);
  const rows = invoices
    .flatMap((invoice) => {
      const firstPaymentDate = firstPaymentByQboInvoiceId.get(invoice.qbo_invoice_id) ?? null;
      const paymentEligible = PAID_STATUSES.has(invoice.payment_status) && firstPaymentDate && Date.parse(firstPaymentDate) >= Date.parse(CUTOFF);
      const existingOrders = ordersByInvoice.get(invoice.id) ?? [];
      const canonicalOrder = existingOrders.find((order) => !order.duplicate_of_order_id) ?? existingOrders[0] ?? null;
      const physicalItems = (linesByInvoice.get(invoice.id) ?? [])
        .filter((line) => Number(line.ordered_qty ?? 0) > 0 && !isNonPhysicalLine(line))
        .map((line) => {
          const productId = line.product_id ?? productMap.get(normalizeSku(line.qbo_sku)) ?? null;
          return {
            qboInvoiceLineId: line.id,
            qboLineId: line.qbo_line_id,
            sku: line.qbo_sku,
            description: line.source_description,
            quantity: Number(line.ordered_qty ?? 0),
            productId,
            mappingStatus: productId ? "MAPPED" : "UNMAPPED",
          };
        });
      const mappedCount = physicalItems.filter((line) => line.productId).length;
      const unmappedCount = physicalItems.length - mappedCount;
      const mappingStatus = physicalItems.length === 0 ? "NO_PHYSICAL_ITEMS" : unmappedCount === 0 ? "ALL_MAPPED" : mappedCount === 0 ? "ALL_UNMAPPED" : "PARTIALLY_MAPPED";
      const eligible = Boolean(paymentEligible) && !isVoided(invoice);

      if (!eligible || physicalItems.length === 0) return [];

      return physicalItems.map((item) => {
        const exactOrderLines = orderLines.filter((line) => line.qbo_invoice_line_id === item.qboInvoiceLineId);
        const exactActiveLines = exactOrderLines.filter(isActiveDemand);
        const exactTerminalLines = exactOrderLines.filter(isTerminalLine);
        const resolution = activeResolutionsByQboLineId.get(String(item.qboInvoiceLineId)) ?? null;
        const exactOrderLineIds = new Set(exactOrderLines.map((line) => line.id));
        const matchingInvoiceNumberOrders = orders.filter((order) => sameText(order.order_number, invoice.invoice_number));
        const manualCandidateOrders = orders.filter((order) => {
          if (order.source_invoice_id === invoice.id || order.duplicate_of_order_id) return false;
          const customerMatches = order.customer_id === invoice.customer_id
            || sameText(order.legacy_customer_name, invoice.customers?.company_name ?? invoice.customers?.full_name)
            || sameText(order.customers?.company_name ?? order.customers?.full_name, invoice.customers?.company_name ?? invoice.customers?.full_name);
          const invoiceNumberMatches = matchingInvoiceNumberOrders.some((candidate) => candidate.id === order.id);
          const matchingLine = (linesByOrder.get(order.id) ?? []).some((line) => line.product_id === item.productId
            && Number(line.ordered_qty ?? 0) === item.quantity
            && !exactOrderLineIds.has(line.id));
          return matchingLine && (customerMatches || invoiceNumberMatches);
        });
        const manualActiveLines = manualCandidateOrders.flatMap((order) => linesByOrder.get(order.id) ?? []).filter((line) => line.product_id === item.productId && isActiveDemand(line));
        const evidence = [
          canonicalOrder ? `QBO parent ${canonicalOrder.order_number ?? canonicalOrder.id}` : null,
          exactOrderLines.length ? `QBO line identity (${exactOrderLines.length})` : null,
          exactActiveLines.length ? `active ERP demand ${exactActiveLines.reduce((sum, line) => sum + remainingDemand(line), 0)}` : null,
          exactTerminalLines.length ? `terminal ERP line (${exactTerminalLines.map((line) => line.fulfillment_status).join(", ")})` : null,
          resolution ? `reviewed ${resolution.resolution_type} resolution` : null,
          manualCandidateOrders.length ? `manual candidate ${manualCandidateOrders.map((order) => order.order_number ?? order.id).join(", ")}` : null,
          manualActiveLines.length ? `manual active demand ${manualActiveLines.reduce((sum, line) => sum + remainingDemand(line), 0)}` : null,
        ].filter(Boolean);

        const classification = resolution || exactTerminalLines.length
          ? "TERMINAL/CLOSED — SKIP"
          : !item.productId
            ? "UNMAPPED SKU — REVIEW"
            : exactOrderLines.length && !canonicalOrder
              ? "POSSIBLE MANUAL DUPLICATE — KADIE REVIEW"
              : canonicalOrder && exactOrderLines.length
                ? "ALREADY IN ERP — SKIP"
                : canonicalOrder
                  ? "PARTIALLY IN ERP — REVIEW MISSING LINES"
                  : manualCandidateOrders.length
                    ? "POSSIBLE MANUAL DUPLICATE — KADIE REVIEW"
                    : "SAFE TO IMPORT";

        return {
          "Invoice #": invoice.invoice_number,
          Customer: invoice.customers?.company_name ?? invoice.customers?.full_name ?? null,
          "Paid Date": firstPaymentDate,
          "QBO SKU": item.sku,
          Qty: item.quantity,
          "Existing ERP Order": canonicalOrder?.order_number ?? (manualCandidateOrders.map((order) => order.order_number ?? order.id).join(", ") || null),
          "Existing Customer List/Demand": {
            exactActiveQuantity: exactActiveLines.reduce((sum, line) => sum + remainingDemand(line), 0),
            manualCandidateActiveQuantity: manualActiveLines.reduce((sum, line) => sum + remainingDemand(line), 0),
          },
          "Match Evidence": evidence.length ? evidence : ["no QBO identity, order number/customer-SKU-quantity candidate, active demand, or terminal evidence"],
          Classification: classification,
          qboInvoiceId: invoice.qbo_invoice_id,
          qboInvoiceLineId: item.qboInvoiceLineId,
          qboLineId: item.qboLineId,
          erpProductId: item.productId,
          paymentStatus: invoice.payment_status,
          mappingStatus,
        };
      });
    })
    .sort((left, right) => String(left["Paid Date"]).localeCompare(String(right["Paid Date"])) || String(left["Invoice #"]).localeCompare(String(right["Invoice #"])));

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "READ_ONLY_PREVIEW",
    cutoff: CUTOFF,
    notes: [
      "First payment dates come directly from QuickBooks Payment records.",
      "No shipping orders, lines, queues, customer demand, inventory, or fulfillment data is written.",
      "Rows are physical QBO lines, so partially represented invoices are visible without treating similar records as an automatic match.",
      "Customer, SKU, and quantity similarity only creates a POSSIBLE MANUAL DUPLICATE — KADIE REVIEW row; it never merges records.",
      "SAFE TO IMPORT is a preflight recommendation only. This report never imports orders.",
    ],
    summary: {
      eligiblePaidOrPartialPhysicalLines: rows.length,
      safeToImport: rows.filter((row) => row.Classification === "SAFE TO IMPORT").length,
      alreadyInErp: rows.filter((row) => row.Classification === "ALREADY IN ERP — SKIP").length,
      partiallyInErp: rows.filter((row) => row.Classification === "PARTIALLY IN ERP — REVIEW MISSING LINES").length,
      terminalOrClosed: rows.filter((row) => row.Classification === "TERMINAL/CLOSED — SKIP").length,
      possibleManualDuplicates: rows.filter((row) => row.Classification === "POSSIBLE MANUAL DUPLICATE — KADIE REVIEW").length,
      unmappedSku: rows.filter((row) => row.Classification === "UNMAPPED SKU — REVIEW").length,
    },
    rows,
  };

  const reportPath = writeJsonFile(path.resolve(`tmp/import-reports/post-shutdown-qbo-order-preview-${timestampSlug()}.json`), report);
  console.log("\n=== Post-Shutdown QuickBooks Order Preview ===\n");
  console.log(report.summary);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown preview failure"));