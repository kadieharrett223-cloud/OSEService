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
  authoritativeSku?: string | null,
) {
  return canonicalSkuKey(preferredOperationalSku(primarySku, aliases, canonicalName, authoritativeSku));
}

/**
 * An exact, non-numeric catalog SKU owns the physical-stock ledger for its
 * canonical product. Historical alias-only identities may share demand and
 * customer-list placement, but they must never add their ledger balance to a
 * live SKU with the same normalized name.
 */
export function authoritativeStockProductIds<T extends { id: string; sku: string | null | undefined }>(
  products: T[],
  canonicalKeyByProductId: Map<string, string>,
  stockLedgerProductIds?: ReadonlySet<string>,
) {
  const directOwnersByKey = new Map<string, Set<string>>();
  for (const product of products) {
    const sku = String(product.sku ?? "").trim();
    if (!sku || /^\d+$/.test(sku)) continue;
    const key = canonicalSkuKey(sku);
    if (!key) continue;
    const owners = directOwnersByKey.get(key) ?? new Set<string>();
    owners.add(product.id);
    directOwnersByKey.set(key, owners);
  }

  const productById = new Map(products.map((product) => [product.id, product]));
  const allowed = new Set<string>();
  for (const [key, directOwners] of directOwnersByKey) {
    const baseSkuOwners = [...directOwners].filter((productId) => {
      const sku = String(productById.get(productId)?.sku ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      return sku === key;
    });
    const baseOwnersWithLedger = baseSkuOwners.filter((productId) => stockLedgerProductIds?.has(productId));

    // A current base SKU with its own on-floor ledger is authoritative. This
    // rejects stale manufacturer-prefixed copies (for example HK-4PC-6) after
    // an operator has corrected the live 4PC-6 balance to zero.
    if (baseOwnersWithLedger.length > 0) {
      for (const productId of baseOwnersWithLedger) allowed.add(productId);
      continue;
    }

    // Some real stock was received only under the prior SKU. Do not turn that
    // inventory into zero merely because a newer base catalog identity exists.
    // In that case the ledger-bearing legacy identity is the only evidence of
    // on-floor stock and remains visible in the merged product row.
    if (stockLedgerProductIds) {
      for (const product of products) {
        if ((canonicalKeyByProductId.get(product.id) ?? product.id) === key && stockLedgerProductIds.has(product.id)) {
          allowed.add(product.id);
        }
      }
      continue;
    }

    for (const productId of directOwners) allowed.add(productId);
  }

  // Products with no exact, nonnumeric catalog owner are still standalone
  // inventory identities and keep their own ledgers.
  for (const product of products) {
    const key = canonicalKeyByProductId.get(product.id) ?? product.id;
    if (!directOwnersByKey.has(key)) allowed.add(product.id);
  }
  return allowed;
}

/** Generic accounting labels describe a line's role, not a reusable product identity. */
export function isUnsafeGlobalProductAlias(value: string | null | undefined) {
  return UNSAFE_GLOBAL_ALIAS_KEYS.has(canonicalSkuKey(value));
}
