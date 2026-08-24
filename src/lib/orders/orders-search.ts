export type OrdersSearchRow = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  searchable: string;
  tabs: string[];
};

const LIFECYCLE_TAB_ORDER = ["cancelled", "archived", "partial", "warehouse", "new", "orders"];

const LIFECYCLE_LABELS: Record<string, string> = {
  new: "New",
  orders: "Orders",
  warehouse: "In Warehouse",
  partial: "Partially Shipped",
  archived: "Archived",
  cancelled: "Cancelled",
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

export function getOrderLifecycleTab(order: Pick<OrdersSearchRow, "tabs">) {
  return LIFECYCLE_TAB_ORDER.find((tab) => order.tabs.includes(tab)) ?? "orders";
}

export function getOrderLifecycleLabel(order: Pick<OrdersSearchRow, "tabs">) {
  return LIFECYCLE_LABELS[getOrderLifecycleTab(order)] ?? "Orders";
}

export function searchOrders<T extends OrdersSearchRow>(orders: T[], searchText: string) {
  const normalizedSearch = normalize(searchText);
  if (!normalizedSearch) return [] as T[];
  return orders.filter((order) => order.searchable.includes(normalizedSearch));
}

export function getExactInvoiceSearchTab<T extends OrdersSearchRow>(orders: T[], searchText: string) {
  const normalizedSearch = normalize(searchText);
  if (!normalizedSearch) return null;
  const exactMatches = orders.filter((order) => normalize(order.invoiceNumber) === normalizedSearch);
  return exactMatches.length === 1 ? getOrderLifecycleTab(exactMatches[0]) : null;
}