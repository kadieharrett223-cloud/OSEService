import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getPackageDimensions, type PackageDimensions } from "./package-dimensions";

type ProductSourceRecord = {
  raw_payload?: {
    sku?: string | null;
    itemCode?: string | null;
    qbMatchText?: string | null;
    lengthInches?: unknown;
    widthInches?: unknown;
    heightInches?: unknown;
    weightLbs?: unknown;
  } | null;
};

const MANUFACTURER_PREFIX = /^(HL|HK|FB|YZ)-/i;
const PREFIX_MERGE_EXCEPTIONS = new Set(["AR1"]);

export function packageDimensionsLookupKey(value: string | null | undefined) {
  const normalize = (candidate: string) => candidate.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const full = normalize(String(value ?? ""));
  const stripped = normalize(String(value ?? "").replace(MANUFACTURER_PREFIX, ""));
  if (!stripped || PREFIX_MERGE_EXCEPTIONS.has(stripped)) return full;
  return stripped;
}

export const getCachedPackageDimensionsBySku = unstable_cache(async () => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("old_erp_source_records")
    .select("raw_payload")
    .eq("source_container", "Products");
  if (error) throw new Error(`Package dimensions lookup failed: ${error.message}`);

  const lookup: Record<string, PackageDimensions> = {};
  for (const sourceRecord of (data ?? []) as ProductSourceRecord[]) {
    const dimensions = getPackageDimensions(sourceRecord.raw_payload);
    if (!dimensions) continue;
    for (const sourceSku of [sourceRecord.raw_payload?.itemCode, sourceRecord.raw_payload?.sku, sourceRecord.raw_payload?.qbMatchText]) {
      const key = packageDimensionsLookupKey(sourceSku);
      if (!key) continue;
      const existing = lookup[key];
      if (!existing || (existing.weightPounds === null && dimensions.weightPounds !== null)) lookup[key] = dimensions;
    }
  }
  return lookup;
}, ["inventory-package-dimensions"], { revalidate: 300 });
