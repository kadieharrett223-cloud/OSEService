const MANUFACTURER_PREFIX = /^(HL|HK|FB|YZ)-/i;
const PREFIX_MERGE_EXCEPTIONS = new Set(["AR1"]);
const GENERIC_ALIAS_KEYS = /^(?:NOTE|SHIPPING|HIGHRISE|\d+YEAR|\d+V(?:OLT)?(?:\d*HP)?)$/;
const UNSAFE_GLOBAL_ALIAS_KEYS = new Set([
  "NOTE",
  "MISCCHARGE",
  "MISCELLANEOUSCHARGE",
  "SHIPPING",
  "FREIGHT",
  "DELIVERY",
  "DISCOUNT",
  "SALESTAX",
  "TAXADJUSTMENT",
]);

export function canonicalSkuKey(value: string | null | undefined) {
  const normalize = (candidate: string) => candidate.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const full = normalize(String(value ?? ""));
  const stripped = normalize(String(value ?? "").replace(MANUFACTURER_PREFIX, ""));
  if (!stripped || PREFIX_MERGE_EXCEPTIONS.has(stripped)) return full;
  return stripped;
}

export function preferredOperationalSku(
  primarySku: string | null | undefined,
  aliases: Array<string | null | undefined> = [],
  canonicalName?: string | null,
  authoritativeSku?: string | null,
) {
  const primary = String(primarySku ?? "").trim().toUpperCase();
  if (primary && !/^\d+$/.test(primary)) return primary;

  // OLD_ERP reused numeric catalog IDs. When the archived product record gives
  // us its item code, that is the product's source-of-truth identity; aliases
  // may include a previous product that once shared the numeric ID.
  const authoritative = String(authoritativeSku ?? "").trim().toUpperCase();
  if (authoritative && !/^\d+$/.test(authoritative) && !GENERIC_ALIAS_KEYS.test(canonicalSkuKey(authoritative))) return authoritative;

  // Recycled QuickBooks item IDs are often numeric. In that case the canonical
  // product name is the explicit operational identity; aliases are merely
  // lookup aids and may contain several historical variants. Never let alias
  // insertion order split one product's customer queue.
  const canonical = String(canonicalName ?? "").trim().toUpperCase();
  if (canonical && !/^\d+$/.test(canonical) && !GENERIC_ALIAS_KEYS.test(canonicalSkuKey(canonical))) return canonical;

  const operationalAlias = aliases
    .map((alias) => String(alias ?? "").trim().toUpperCase())
    .find((alias) => alias && !/^\d+$/.test(alias) && !GENERIC_ALIAS_KEYS.test(canonicalSkuKey(alias)));
  return operationalAlias ?? primary;
}

export function canonicalProductSkuKey(
  primarySku: string | null | undefined,
  aliases: Array<string | null | undefined> = [],
  canonicalName?: string | null,
) {
  return canonicalSkuKey(preferredOperationalSku(primarySku, aliases, canonicalName));
}

/** Generic accounting labels describe a line's role, not a reusable product identity. */
export function isUnsafeGlobalProductAlias(value: string | null | undefined) {
  return UNSAFE_GLOBAL_ALIAS_KEYS.has(canonicalSkuKey(value));
}
