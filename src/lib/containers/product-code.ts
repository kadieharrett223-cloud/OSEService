import { preferredOperationalSku } from "@/lib/products/canonical-sku";

/** Current catalog labels win over recycled numeric IDs in the legacy archive. Display only. */
export function containerProductCode(sku: string | null, name: string | null, aliases: string[] = [], archivedCode?: string) {
  const primary = String(sku ?? "").trim().toUpperCase();
  if (primary && !/^\d+$/.test(primary)) return primary.replace(/^(HL|HK|FB|YZ)-/, "");
  const currentCode = String(name ?? "").trim().toUpperCase()
    .match(/^(?:MODEL:\s*)?(?:OLYMPIC\s+)?(?:(?:HL|HK|FB|YZ)-)?([A-Z0-9]+(?:-[A-Z0-9]+)+)\b/)?.[1];
  return currentCode || preferredOperationalSku(sku, aliases, name, archivedCode);
}
