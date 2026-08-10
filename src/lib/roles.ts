export type AppRole = "sales" | "shipping" | "staff" | "admin";

export function normalizeRole(role?: string | null): AppRole {
  const normalized = (role ?? "").trim().toLowerCase();

  if (normalized === "sales" || normalized === "salesperson") {
    return "sales";
  }

  if (normalized === "shipping" || normalized === "warehouse") {
    return "shipping";
  }

  if (normalized === "admin" || normalized === "manager") {
    return "admin";
  }

  return "staff";
}

export function inferRoleFromName(fullName?: string | null): AppRole {
  const normalized = (fullName ?? "").trim().toLowerCase();
  if (normalized.includes("sales") || normalized.includes("sale")) return "sales";
  if (normalized.includes("ship") || normalized.includes("warehouse")) return "shipping";
  return "staff";
}

export function canViewMySales(role?: string | null): boolean {
  const normalized = normalizeRole(role);
  return normalized === "sales" || normalized === "admin";
}

export function canAccessShipping(role?: string | null): boolean {
  const normalized = normalizeRole(role);
  return normalized === "shipping" || normalized === "admin" || normalized === "staff";
}
