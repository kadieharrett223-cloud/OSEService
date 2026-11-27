export type PackagePiece = {
  label: string;
  quantity: number;
  lengthInches: number;
  widthInches: number;
  heightInches: number;
  /** Combined weight of this group; never multiply this by quantity again. */
  totalWeightPounds: number | null;
};

export type PackageDimensions = {
  lengthInches: number | null;
  widthInches: number | null;
  heightInches: number | null;
  weightPounds: number | null;
  packages?: PackagePiece[];
};

type PackageSourcePayload = {
  lengthInches?: unknown;
  widthInches?: unknown;
  heightInches?: unknown;
  weightLbs?: unknown;
};

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function getPackageDimensions(payload: PackageSourcePayload | null | undefined): PackageDimensions | null {
  const lengthInches = positiveNumber(payload?.lengthInches);
  const widthInches = positiveNumber(payload?.widthInches);
  const heightInches = positiveNumber(payload?.heightInches);
  const weightPounds = positiveNumber(payload?.weightLbs);
  if (lengthInches === null && widthInches === null && heightInches === null && weightPounds === null) return null;
  return {
    lengthInches,
    widthInches,
    heightInches,
    weightPounds,
  };
}

export function formatPackageDimensions(dimensions: PackageDimensions) {
  if (dimensions.packages?.length) {
    return dimensions.packages.map(piece => {
      const count = piece.quantity > 1 ? `${piece.quantity} × ` : "";
      const size = `${formatNumber(piece.lengthInches)} × ${formatNumber(piece.widthInches)} × ${formatNumber(piece.heightInches)} in`;
      const weight = piece.totalWeightPounds === null ? "" : ` (${formatNumber(piece.totalWeightPounds)} lb${piece.quantity > 1 ? " combined" : ""})`;
      return `${piece.label}: ${count}${size}${weight}`;
    }).join("; ");
  }
  if (dimensions.lengthInches === null || dimensions.widthInches === null || dimensions.heightInches === null) return null;
  return `${formatNumber(dimensions.lengthInches)} × ${formatNumber(dimensions.widthInches)} × ${formatNumber(dimensions.heightInches)} in`;
}

export function formatPackageWeight(dimensions: PackageDimensions) {
  return dimensions.weightPounds === null ? null : `${formatNumber(dimensions.weightPounds)} lb${dimensions.packages?.length ? " total" : ""}`;
}
