const MANUFACTURER_PREFIX = /^(HL|HK|FB|YZ)-/i;
const PREFIX_MERGE_EXCEPTIONS = new Set(["AR1"]);

export function canonicalSkuKey(value: string | null | undefined) {
  const normalize = (candidate: string) => candidate.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const full = normalize(String(value ?? ""));
  const stripped = normalize(String(value ?? "").replace(MANUFACTURER_PREFIX, ""));
  if (!stripped || PREFIX_MERGE_EXCEPTIONS.has(stripped)) return full;
  return stripped;
}

export function preferredOperationalSku(primarySku: string | null | undefined, aliases: Array<string | null | undefined> = []) {
  const operationalAlias = aliases
    .map((alias) => String(alias ?? "").trim().toUpperCase())
    .find((alias) => alias && !/^\d+$/.test(alias));
  return operationalAlias ?? String(primarySku ?? "").trim().toUpperCase();
}

export function canonicalProductSkuKey(primarySku: string | null | undefined, aliases: Array<string | null | undefined> = []) {
  return canonicalSkuKey(preferredOperationalSku(primarySku, aliases));
}