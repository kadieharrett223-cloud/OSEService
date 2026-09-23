import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type OldErpProductSourceRow = {
  source_record_id: string | null;
  raw_payload?: {
    itemCode?: string | null;
    qbMatchText?: string | null;
  } | null;
};

/**
 * Numeric OLD_ERP catalog ids were recycled.  This immutable archive is the
 * only reliable way to identify the active item behind such an id; aliases are
 * lookup aids and can contain an older item that used the same numeric id.
 */
export const getCachedOldErpProductIdentityBySourceRecordId = unstable_cache(async () => {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("old_erp_source_records")
    .select("source_record_id, raw_payload")
    .eq("source_container", "Products");
  if (error) throw new Error(`OLD_ERP product identity lookup failed: ${error.message}`);

  const identityBySourceRecordId: Record<string, string> = {};
  for (const source of (data ?? []) as OldErpProductSourceRow[]) {
    const sourceId = String(source.source_record_id ?? "").trim();
    const itemCode = String(source.raw_payload?.itemCode ?? source.raw_payload?.qbMatchText ?? "").trim().toUpperCase();
    if (sourceId && itemCode && !/^\d+$/.test(itemCode)) identityBySourceRecordId[sourceId] = itemCode;
  }
  return identityBySourceRecordId;
}, ["old-erp-product-identity-by-source-record"], { revalidate: 300 });
