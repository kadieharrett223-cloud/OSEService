import { formatPackageDimensions, formatPackageWeight, type PackageDimensions } from "@/lib/products/package-dimensions";

export function PackageDimensionsDetails({ dimensions }: { dimensions: PackageDimensions }) {
  const weight = formatPackageWeight(dimensions);
  return (
    <div className="grid gap-2 border-l-2 border-[#2563eb] pl-3 text-sm text-[#334155] sm:grid-cols-2">
      <div><span className="font-semibold text-[#0f172a]">Package:</span> {formatPackageDimensions(dimensions)}</div>
      <div><span className="font-semibold text-[#0f172a]">Weight:</span> {weight ?? "Not on file"}</div>
    </div>
  );
}