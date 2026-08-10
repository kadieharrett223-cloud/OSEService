import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type ScheduleOrder = {
  id: string;
  promised_ship_date: string | null;
  shipping_method: string | null;
  carrier: string | null;
  tracking_number: string | null;
  customers?: {
    company_name: string | null;
    full_name: string | null;
  } | null;
  qbo_invoices?: {
    invoice_number: string | null;
  } | null;
};

type ViewMode = "month" | "week" | "day";

function normalizeView(value: string | undefined): ViewMode {
  if (value === "week" || value === "day") return value;
  return "month";
}

function formatDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function inRange(dateValue: string, view: ViewMode) {
  const now = new Date();
  const target = new Date(`${dateValue}T12:00:00`);
  if (Number.isNaN(target.getTime())) return false;

  if (view === "day") {
    return now.toDateString() === target.toDateString();
  }

  if (view === "week") {
    const weekStart = new Date(now);
    const day = weekStart.getDay();
    weekStart.setDate(weekStart.getDate() - day);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    return target >= weekStart && target < weekEnd;
  }

  return target.getFullYear() === now.getFullYear() && target.getMonth() === now.getMonth();
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const supabase = await createClient();
  const { view } = await searchParams;
  const activeView = normalizeView(view);

  const { data: rows, error } = await supabase
    .from("shipping_orders")
    .select(`
      id,
      promised_ship_date,
      shipping_method,
      carrier,
      tracking_number,
      customers (company_name, full_name),
      qbo_invoices (invoice_number)
    `)
    .not("promised_ship_date", "is", null)
    .order("promised_ship_date", { ascending: true });

  const orders = ((rows ?? []) as ScheduleOrder[])
    .filter((row) => Boolean(row.promised_ship_date && inRange(row.promised_ship_date, activeView)));

  const grouped = orders.reduce<Record<string, ScheduleOrder[]>>((acc, row) => {
    const key = row.promised_ship_date ?? "Unknown";
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  const dateKeys = Object.keys(grouped).sort();

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Schedule</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">Shared live shipping calendar based on scheduled order dates.</p>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {[
            { id: "month", label: "Month" },
            { id: "week", label: "Week" },
            { id: "day", label: "Day" },
          ].map((tab) => {
            const active = activeView === tab.id;
            return (
              <Link
                key={tab.id}
                href={`/schedule?view=${tab.id}`}
                className={`rounded-full px-3 py-2 text-sm font-semibold ${active ? "bg-[#111827] text-white" : "bg-[#f3f4f6] text-[#374151]"}`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        {error ? (
          <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load schedule right now.</div>
        ) : null}

        {!error && dateKeys.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No scheduled orders in this view.
          </div>
        ) : null}

        {!error && dateKeys.length > 0 ? (
          <div className="space-y-4">
            {dateKeys.map((dateKey) => (
              <section key={dateKey} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                <h2 className="text-lg font-semibold text-[#111827]">{formatDate(dateKey)}</h2>
                <div className="mt-3 space-y-2">
                  {grouped[dateKey].map((order) => {
                    const customer = order.customers?.company_name ?? order.customers?.full_name ?? "Customer pending";
                    const method = order.shipping_method ?? "Shipment";
                    const invoice = order.qbo_invoices?.invoice_number ?? "—";
                    return (
                      <div key={order.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#e5e7eb] bg-white p-3">
                        <div>
                          <p className="font-semibold text-[#111827]">{customer}</p>
                          <p className="text-sm text-[#5a5a5a]">Invoice {invoice} · {method}</p>
                          <p className="text-xs text-[#6b7280]">Carrier: {order.carrier ?? "—"} · Tracking: {order.tracking_number ?? "—"}</p>
                        </div>
                        <Link href={`/orders/${order.id}`} className="btn-secondary">Open Order</Link>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
