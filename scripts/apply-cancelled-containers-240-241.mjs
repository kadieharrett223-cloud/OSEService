#!/usr/bin/env node
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const REPORT_FILE = "tmp/import-reports/cancelled-containers-240-241-result.json";
const TARGETS = [
  { id: "35270322-a7f1-4cb0-88c4-bea8e0bfc592", number: "240", lines: [{ sku: "000011", qty: 24 }, { sku: "HPU1103", qty: 24 }] },
  { id: "feaf6479-44fc-45df-8402-fd96245daf86", number: "241", lines: [{ sku: "FBCJ-6", qty: 45 }, { sku: "HLCJ-6", qty: 25 }, { sku: "YZRCJ-7", qty: 45 }] },
];
const JOE_ALLOCATION_ID = "507cd1ce-1537-4807-bbb6-8df6a1671749";
const number = (value) => Number(value ?? 0);

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase credentials. Run with node --env-file=.env.local.");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function loadState() {
  const ids = TARGETS.map((target) => target.id);
  const [containersResult, linesResult, transactionsResult, allocationsResult] = await Promise.all([
    db.from("containers").select("id,container_number,lifecycle_status").in("id", ids),
    db.from("container_lines").select("container_id,on_order_qty,received_qty,products(sku)").in("container_id", ids),
    db.from("inventory_transactions").select("id,container_id").in("container_id", ids),
    db.from("inventory_allocations").select("id,container_id,shipping_order_line_id,product_id,quantity,allocation_status,source_type").in("container_id", ids),
  ]);
  for (const result of [containersResult, linesResult, transactionsResult, allocationsResult]) if (result.error) throw result.error;
  return { containers: containersResult.data ?? [], lines: linesResult.data ?? [], transactions: transactionsResult.data ?? [], allocations: allocationsResult.data ?? [] };
}

function validate(state, allowCancelled) {
  const failures = [];
  if (state.containers.length !== TARGETS.length) failures.push("One or more approved containers no longer exists.");
  for (const target of TARGETS) {
    const container = state.containers.find((row) => row.id === target.id);
    if (!container || container.container_number !== target.number) failures.push(`Container identity changed for ${target.number}.`);
    if (container && !["PRODUCTION", ...(allowCancelled ? ["CANCELLED"] : [])].includes(String(container.lifecycle_status).toUpperCase())) failures.push(`Container ${target.number} is not in the approved lifecycle state.`);
    const actual = state.lines.filter((line) => line.container_id === target.id).map((line) => ({ sku: line.products?.sku ?? null, onOrder: number(line.on_order_qty), received: number(line.received_qty) }));
    if (actual.length !== target.lines.length || actual.some((line) => line.received !== 0 || !target.lines.some((expected) => expected.sku === line.sku && expected.qty === line.onOrder))) failures.push(`Container ${target.number} contents or receipt state changed since approval.`);
  }
  if (state.transactions.length !== 0) failures.push("A target container now has inventory transaction evidence.");
  const active = state.allocations.filter((allocation) => allocation.allocation_status !== "RELEASED");
  if (allowCancelled) {
    if (active.length !== 0) failures.push("A target container still has an active allocation after the correction.");
  } else if (active.length !== 1 || active[0].id !== JOE_ALLOCATION_ID || active[0].container_id !== TARGETS[1].id || active[0].source_type !== "CONTAINER" || number(active[0].quantity) !== 1) failures.push("Persisted allocation state no longer matches the approved Joe Sciarra release.");
  return failures;
}

const before = await loadState();
const alreadyApplied = before.containers.length === TARGETS.length
  && before.containers.every((container) => String(container.lifecycle_status).toUpperCase() === "CANCELLED")
  && before.allocations.every((allocation) => allocation.allocation_status === "RELEASED");
const preconditionFailures = validate(before, alreadyApplied);
if (preconditionFailures.length) throw new Error(`Refusing correction: ${JSON.stringify(preconditionFailures)}`);
const result = { generatedAt: new Date().toISOString(), apply: APPLY, alreadyApplied, targetContainers: TARGETS.map((target) => ({ number: target.number, id: target.id })), incomingReduction: 163, releasedAllocationId: JOE_ALLOCATION_ID, preconditionFailures, applied: false };

if (APPLY && !alreadyApplied) {
  const released = await db.from("inventory_allocations").update({ allocation_status: "RELEASED" }).eq("id", JOE_ALLOCATION_ID).eq("allocation_status", "ALLOCATED").select("id");
  if (released.error || released.data?.length !== 1) throw new Error(released.error?.message ?? "Joe Sciarra allocation was not released exactly once.");
  for (const target of TARGETS) {
    const update = await db.from("containers").update({ lifecycle_status: "CANCELLED" }).eq("id", target.id).eq("lifecycle_status", "PRODUCTION").select("id");
    if (update.error || update.data?.length !== 1) throw new Error(update.error?.message ?? `Container ${target.number} was not cancelled exactly once.`);
  }
  const audit = await db.from("audit_log").insert(TARGETS.map((target) => ({ entity_type: "container", entity_id: target.id, action: "CONTAINER_CANCELLED_BUSINESS_CORRECTION", details: { container_number: target.number, prior_lifecycle_status: "PRODUCTION", new_lifecycle_status: "CANCELLED", incoming_reduction_units: target.lines.reduce((sum, line) => sum + line.qty, 0), preserved_container_lines: true, inventory_changed: false, sold_changed: false, on_floor_changed: false, released_allocation_id: target.number === "241" ? JOE_ALLOCATION_ID : null, released_allocation_reason: target.number === "241" ? "Cancelled source; canonical coverage determines future availability without manual reassignment." : null } })));
  if (audit.error) throw new Error(audit.error.message);
  result.applied = true;
}

const after = await loadState();
const postconditionFailures = APPLY ? validate(after, true) : [];
result.postconditionFailures = postconditionFailures;
result.after = { lifecycleStatuses: after.containers.map((row) => ({ containerNumber: row.container_number, lifecycleStatus: row.lifecycle_status })), activeTargetAllocations: after.allocations.filter((row) => row.allocation_status !== "RELEASED").length, transactionCount: after.transactions.length };
result.passed = preconditionFailures.length === 0 && postconditionFailures.length === 0;
fs.mkdirSync("tmp/import-reports", { recursive: true });
fs.writeFileSync(REPORT_FILE, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ apply: APPLY, result: result.passed ? "passed" : "failed", ...result.after, report: REPORT_FILE }, null, 2));
if (!result.passed) process.exitCode = 1;