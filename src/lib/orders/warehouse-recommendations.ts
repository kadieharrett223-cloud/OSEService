export type WarehouseRecommendationCandidate = {
  id: string;
  createdAt: string;
  requirements: Array<{ productId: string; quantity: number }>;
};

export function recommendWarehouseOrderIds({
  candidates,
  floorQuantityByProduct,
  reservedQuantityByProduct,
  limit = 10,
}: {
  candidates: WarehouseRecommendationCandidate[];
  floorQuantityByProduct: Map<string, number>;
  reservedQuantityByProduct: Map<string, number>;
  limit?: number;
}) {
  const availableByProduct = new Map<string, number>();
  for (const [productId, quantity] of floorQuantityByProduct) {
    availableByProduct.set(productId, Math.max(0, quantity - (reservedQuantityByProduct.get(productId) ?? 0)));
  }

  const recommended: string[] = [];
  const oldestFirst = candidates.slice().sort((left, right) => {
    const leftCreated = Date.parse(left.createdAt) || Number.MAX_SAFE_INTEGER;
    const rightCreated = Date.parse(right.createdAt) || Number.MAX_SAFE_INTEGER;
    return leftCreated - rightCreated || left.id.localeCompare(right.id);
  });

  for (const candidate of oldestFirst) {
    if (recommended.length >= limit || candidate.requirements.length === 0) continue;
    const requiredByProduct = new Map<string, number>();
    for (const requirement of candidate.requirements) {
      if (!requirement.productId || requirement.quantity <= 0) continue;
      requiredByProduct.set(requirement.productId, (requiredByProduct.get(requirement.productId) ?? 0) + requirement.quantity);
    }
    if (requiredByProduct.size === 0) continue;
    if ([...requiredByProduct].every(([productId, quantity]) => (availableByProduct.get(productId) ?? 0) >= quantity)) {
      recommended.push(candidate.id);
      for (const [productId, quantity] of requiredByProduct) {
        availableByProduct.set(productId, (availableByProduct.get(productId) ?? 0) - quantity);
      }
    }
  }

  return recommended;
}