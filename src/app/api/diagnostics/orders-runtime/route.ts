import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function fetchAllRows<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const pageSize = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) break;
  }
  return rows;
}

export async function GET() {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseHostname = (() => {
    try {
      return new URL(supabaseUrl).hostname;
    } catch {
      return "invalid-or-missing-url";
    }
  })();

  let orders: unknown[] = [];
  let lines: unknown[] = [];
  let manualRows: unknown[] = [];
  let queryError: Error | null = null;
  try {
    [orders, lines] = await Promise.all([
      fetchAllRows((from, to) => supabase
      .from("shipping_orders")
      .select(`
        id,
        order_number,
        source_type,
        legacy_customer_name,
        review_status,
        created_at,
        customers (company_name, full_name),
        qbo_invoices (invoice_number),
        shipping_order_lines (
          id,
          product_id,
          legacy_item_code,
          approval_status,
          warehouse_status,
          fulfillment_status,
          ordered_qty,
          approved_qty,
          fulfilled_qty,
          products (sku, canonical_name)
        )
      `)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)),
      fetchAllRows((from, to) => supabase
        .from("shipping_order_lines")
      .select("id, shipping_order_id, product_id, legacy_item_code, approval_status, warehouse_status, fulfillment_status, ordered_qty, approved_qty, fulfilled_qty, products(sku, canonical_name)")
      .order("id", { ascending: true })
        .range(from, to)),
    ]);
    const { data: rawManualRows, error: manualError } = await supabase.from("manual_product_mapping_queue").select("source_sku").eq("status", "OPEN");
    if (manualError) throw new Error(manualError.message);
    manualRows = rawManualRows ?? [];
  } catch (error) {
    queryError = error instanceof Error ? error : new Error("Unable to load diagnostic data");
  }
  const [{ count: orderCount }, { count: lineCount }] = await Promise.all([
    supabase.from("shipping_orders").select("id", { count: "exact", head: true }),
    supabase.from("shipping_order_lines").select("id", { count: "exact", head: true }),
  ]);

  const error = queryError;
  if (error) {
    return NextResponse.json({
      deployedCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? "not-exposed",
      supabaseHostname,
      error: error.message,
    }, { status: 500 });
  }

  const typedLines = lines as Array<Record<string, any>>;
  const manualMappingSkus = new Set((manualRows as Array<{ source_sku: string | null }>).map((row) => String(row.source_sku ?? "").trim().toUpperCase()));
  const remaining = (line: { approved_qty?: number | null; ordered_qty?: number | null; fulfilled_qty?: number | null }) => Math.max(0, Number(line.approved_qty ?? line.ordered_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
  const predicateReason = (order: {
    order_number?: string | null;
    shipping_order_lines?: Array<{
      product_id?: string | null;
      legacy_item_code?: string | null;
      approval_status?: string | null;
      fulfillment_status?: string | null;
      approved_qty?: number | null;
      ordered_qty?: number | null;
      fulfilled_qty?: number | null;
      products?: { sku?: string | null } | null;
    }>;
  }) => {
    if (order.order_number === "126037") return "protected invoice 126037";
    const linesForOrder = order.shipping_order_lines ?? [];
    if (linesForOrder.length === 0) return "no parent-query child lines";
    if (!linesForOrder.some((line) => line.product_id)) return "no mapped product_id";
    if (!linesForOrder.some((line) => ["APPROVED", "PARTIAL"].includes(String(line.approval_status ?? "").toUpperCase()))) return "no APPROVED/PARTIAL line";
    if (!linesForOrder.some((line) => remaining(line) > 0)) return "no remaining quantity";
    if (linesForOrder.every((line) => ["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(String(line.fulfillment_status ?? "").toUpperCase()))) return "all lines closed";
    if (linesForOrder.every((line) => manualMappingSkus.has(String(line.products?.sku ?? "").trim().toUpperCase()) || manualMappingSkus.has(String(line.legacy_item_code ?? "").trim().toUpperCase()))) return "all lines held by manual mapping queue";
    return "not excluded by predicate";
  };

  const parentOrders = orders as Array<{
    id: string;
    order_number: string | null;
    shipping_order_lines?: Array<Record<string, unknown>>;
  }>;
  const targetParentOrders = parentOrders.filter((order) => String(order.order_number ?? "") === "126166");
  const directTargetLines = typedLines.filter((line) => targetParentOrders.some((order) => order.id === line.shipping_order_id));
  const activeParentOrders = parentOrders.filter((order) => {
    const typedLines = (order.shipping_order_lines ?? []) as Array<{
      product_id?: string | null;
      legacy_item_code?: string | null;
      approval_status?: string | null;
      fulfillment_status?: string | null;
      approved_qty?: number | null;
      ordered_qty?: number | null;
      fulfilled_qty?: number | null;
      products?: { sku?: string | null } | null;
    }>;
    return typedLines.some((line) => Boolean(line.product_id)
      && !manualMappingSkus.has(String(line.products?.sku ?? "").trim().toUpperCase())
      && !manualMappingSkus.has(String(line.legacy_item_code ?? "").trim().toUpperCase())
      && order.order_number !== "126037"
      && ["APPROVED", "PARTIAL"].includes(String(line.approval_status ?? "").toUpperCase())
      && remaining(line) > 0
      && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(String(line.fulfillment_status ?? "").toUpperCase()));
  });

  return NextResponse.json({
    deployedCommitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? "not-exposed",
    supabaseHostname,
    totalShippingOrders: orderCount ?? null,
    totalShippingOrderLines: lineCount ?? null,
    parentOrdersFetchedByOrdersQuery: parentOrders.length,
    parentOrdersAfterActiveDemandPredicate: activeParentOrders.length,
    invoice126166Exists: targetParentOrders.length > 0,
    invoice126166DirectLinesReturned: directTargetLines.length,
    invoice126166ActiveDirectLines: directTargetLines.filter((line) => remaining(line) > 0 && ["APPROVED", "PARTIAL"].includes(String(line.approval_status ?? "").toUpperCase())).length,
    invoice126166ParentPredicateReason: targetParentOrders.length > 0 ? targetParentOrders.map((order) => ({ orderId: order.id, reason: predicateReason(order) })) : "invoice not returned by parent query",
    manualMappingExceptionSkuCount: manualMappingSkus.size,
  });
}