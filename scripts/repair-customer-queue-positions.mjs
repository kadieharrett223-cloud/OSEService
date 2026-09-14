import { createClient } from "@supabase/supabase-js";

const apply = process.argv.includes("--apply");
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function fetchAll() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("shipping_order_lines")
      .select("id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,queue_position_start,queue_position_count,queue_position_override,queue_position_override_reason,queue_position_override_at,queue_position_override_by,shipping_orders(created_at,first_payment_at,duplicate_of_order_id,cancellation_status,qbo_invoices(invoice_date,raw_payload))")
      .order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

const upper = (value) => String(value ?? "").trim().toUpperCase();
const obligation = (line) => Math.max(0, Number(line.ordered_qty ?? 0), Number(line.approved_qty ?? 0));
const auditedOverride = (line) => Number.isInteger(Number(line.queue_position_override))
  && Number(line.queue_position_override) > 0
  && Boolean(line.queue_position_override_reason || line.queue_position_override_at || line.queue_position_override_by);
const eligible = (line) => Boolean(line.product_id)
  && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status))
  && obligation(line) > Number(line.fulfilled_qty ?? 0)
  && !["FULFILLED", "SHIPPED", "CANCELLED", "REPLACED"].includes(upper(line.fulfillment_status))
  && !line.shipping_orders?.duplicate_of_order_id
  && upper(line.shipping_orders?.cancellation_status) !== "CANCELLED"
  && upper(line.shipping_orders?.qbo_invoices?.raw_payload?.PrivateNote) !== "VOIDED";

function compare(left, right) {
  const leftManual = auditedOverride(left);
  const rightManual = auditedOverride(right);
  if (leftManual || rightManual) {
    if (!leftManual) return 1;
    if (!rightManual) return -1;
    if (Number(left.queue_position_override) !== Number(right.queue_position_override)) {
      return Number(left.queue_position_override) - Number(right.queue_position_override);
    }
  }
  const leftPriority = Date.parse(left.shipping_orders?.first_payment_at ?? left.shipping_orders?.qbo_invoices?.invoice_date ?? "");
  const rightPriority = Date.parse(right.shipping_orders?.first_payment_at ?? right.shipping_orders?.qbo_invoices?.invoice_date ?? "");
  if (Number.isFinite(leftPriority) !== Number.isFinite(rightPriority)) return Number.isFinite(leftPriority) ? -1 : 1;
  if (Number.isFinite(leftPriority) && leftPriority !== rightPriority) return leftPriority - rightPriority;
  const leftCreated = Date.parse(left.shipping_orders?.created_at ?? "") || Number.MAX_SAFE_INTEGER;
  const rightCreated = Date.parse(right.shipping_orders?.created_at ?? "") || Number.MAX_SAFE_INTEGER;
  return leftCreated - rightCreated || left.id.localeCompare(right.id);
}

function position(lines) {
  const manual = lines.filter(auditedOverride).sort(compare);
  const automatic = lines.filter((line) => !auditedOverride(line)).sort(compare);
  const result = [];
  let next = 1;
  const place = (line, start) => {
    const units = obligation(line) - Number(line.fulfilled_qty ?? 0);
    result.push({ line, start, units });
    next = start + units;
  };
  for (const line of manual) {
    const target = Number(line.queue_position_override);
    while (automatic.length) {
      const candidate = automatic[0];
      const units = obligation(candidate) - Number(candidate.fulfilled_qty ?? 0);
      if (next + units - 1 >= target) break;
      place(automatic.shift(), next);
    }
    place(line, Math.max(next, target));
  }
  for (const line of automatic) place(line, next);
  return result;
}

const allLines = await fetchAll();
const byProduct = new Map();
for (const line of allLines.filter(eligible)) {
  byProduct.set(line.product_id, [...(byProduct.get(line.product_id) ?? []), line]);
}
const desired = new Map();
for (const lines of byProduct.values()) {
  for (const row of position(lines)) desired.set(row.line.id, { start: row.start, count: row.units });
}
const changes = allLines.flatMap((line) => {
  const target = desired.get(line.id);
  if (target && (Number(line.queue_position_start ?? 0) !== target.start || Number(line.queue_position_count ?? 0) !== target.count)) {
    return [{ id: line.id, ...target }];
  }
  if (!target && line.queue_position_start != null) return [{ id: line.id, start: null, count: null }];
  return [];
});
const missingBefore = allLines.filter((line) => eligible(line) && line.queue_position_start == null).length;
console.log(JSON.stringify({ mode: apply ? "apply" : "preview", eligibleLines: desired.size, products: byProduct.size, missingBefore, changes: changes.length }, null, 2));

if (apply) {
  for (const change of changes) {
    const { error } = await supabase.from("shipping_order_lines")
      .update({ queue_position_start: change.start, queue_position_count: change.count })
      .eq("id", change.id);
    if (error) throw new Error(`${change.id}: ${error.message}`);
  }
  const refreshed = await fetchAll();
  const missingAfter = refreshed.filter((line) => eligible(line) && line.queue_position_start == null).length;
  console.log(JSON.stringify({ applied: changes.length, missingAfter }, null, 2));
  if (missingAfter !== 0) process.exitCode = 1;
}
