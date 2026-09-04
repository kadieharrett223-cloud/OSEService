const MANUFACTURER_PREFIX = /^(HL|HK|FB|YZ)-/i;
const PREFIX_MERGE_EXCEPTIONS = new Set(["AR1"]);
const GENERIC_ALIAS_KEYS = /^(?:NOTE|SHIPPING|HIGHRISE|\d+YEAR|\d+V(?:OLT)?(?:\d*HP)?)$/;

export function canonicalSkuKey(value: string | null | undefined) {
  const normalize = (candidate: string) => candidate.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const full = normalize(String(value ?? ""));
  const stripped = normalize(String(value ?? "").replace(MANUFACTURER_PREFIX, ""));
  if (!stripped || PREFIX_MERGE_EXCEPTIONS.has(stripped)) return full;
  return stripped;
}

export function preferredOperationalSku(primarySku: string | null | undefined, aliases: Array<string | null | undefined> = []) {
  const primary = String(primarySku ?? "").trim().toUpperCase();
  if (primary && !/^\d+$/.test(primary)) return primary;

  const operationalAlias = aliases
    .map((alias) => String(alias ?? "").trim().toUpperCase())
    .find((alias) => alias && !/^\d+$/.test(alias) && !GENERIC_ALIAS_KEYS.test(canonicalSkuKey(alias)));
  return operationalAlias ?? primary;
}

export function canonicalProductSkuKey(primarySku: string | null | undefined, aliases: Array<string | null | undefined> = []) {
  return canonicalSkuKey(preferredOperationalSku(primarySku, aliases));
}