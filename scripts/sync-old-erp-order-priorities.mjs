#!/usr/bin/env node

import { createSupabaseAdminClient, fail, loadCosmosSources, normalizeText, queueRecordQty } from "./old-erp-migration-utils.mjs";

function normalizePriority(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "false" || raw === "no" || raw === "normal") return "NORMAL";
  if (raw.includes("critical") || raw === "p0") return "CRITICAL";
  if (raw.includes("high") || raw === "p1" || raw === "true" || raw === "yes") return "HIGH";
  if (raw.includes("low") || raw === "p3") return "LOW";
  return "NORMAL";
}

async function loadAll(supabase) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("shipping_order_lines").select("id, source_record_id, priority").range(from, from + 999);
    if (error) fail(`Could not read live order lines: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

const sources = loadCosmosSources({ exportsDir: "tmp/exports" });
const supabase = createSupabaseAdminClient();
const liveLines = await loadAll(supabase);
const liveBySourceId = new Map(liveLines.filter((row) => row.source_record_id).map((row) => [row.source_record_id, row]));
const changes = [];

for (const source of sources.invoiceQueueItems) {
  const sourceId = normalizeText(source.id ?? source._id ?? source.recordId ?? source.lineId ?? source.queueLineId);
  if (!sourceId || queueRecordQty(source) <= 0) continue;
  const live = liveBySourceId.get(sourceId);
  if (!live) continue;
  const expected = normalizePriority(source.priorityFlag);
  if (normalizePriority(live.priority) === expected) continue;
  changes.push({ id: live.id, sourceRecordId: sourceId, from: live.priority, to: expected });
}

let updated = 0;
for (const change of changes) {
  const { error } = await supabase.from("shipping_order_lines").update({ priority: change.to }).eq("id", change.id);
  if (error) fail(`Could not update priority for ${change.sourceRecordId}: ${error.message}`);
  updated += 1;
}

console.log({ matchedPriorityChanges: changes.length, updated });
