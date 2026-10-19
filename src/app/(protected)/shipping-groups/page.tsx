import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { loadShippingGroupCandidates } from "@/lib/shipping/shipping-groups-loader";
import {
  ageDays,
  groupShippingCandidates,
  type ShippingCandidate,
} from "@/lib/shipping/shipping-groups";

function bounded(
  value: string | string[] | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}
function OrderCard({ order, now }: { order: ShippingCandidate; now: Date }) {
  const age = ageDays(order.orderDate, now);
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{order.customer}</h3>
          <Link
            className="text-blue-700 underline"
            href={`/orders/${order.orderId}`}
            prefetch={false}
          >
            Invoice #{order.invoice}
          </Link>
        </div>
        <span className="text-sm text-slate-600">
          Order age: {age === null ? "Unknown" : `${age} days`}
        </span>
      </div>
      <p className="mt-2 text-sm">
        {order.address
          ? `${order.address.street} · ${order.address.city}, ${order.address.state} ${order.address.zip}`
          : "Invoice delivery address requires confirmation"}
      </p>
      {order.addressIssue ? (
        <p className="mt-2 text-sm text-amber-800">{order.addressIssue}</p>
      ) : null}
      <ul className="mt-3 space-y-2 text-sm">
        {order.lifts.map((lift, i) => (
          <li key={`${lift.sku}-${i}`}>
            <strong>
              {lift.quantity} × {lift.sku}
            </strong>{" "}
            · Customer queue #{lift.queuePosition}
            <br />
            <span className="text-slate-600">
              Per-unit packed data: {lift.packageLabel}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Priority date: {order.priorityDate?.slice(0, 10) ?? "Unknown"} ·
        Promised delivery date: not separately recorded; review instructions.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Delivery requirements (unloading equipment, residential access,
        appointment, liftgate): confirm before quoting.
      </p>
      {order.instructions ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer">Order / QBO instructions</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">
            {order.instructions}
          </p>
        </details>
      ) : null}
    </article>
  );
}
export default async function ShippingGroupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await searchParams;
  const maxMiles = bounded(params.miles, 120, 10, 500),
    maxWaitDays = bounded(params.wait, 7, 1, 60);
  const data = await loadShippingGroupCandidates();
  const now = new Date(data.checkedAt);
  const { groups, review } = groupShippingCandidates(
    data.candidates,
    maxMiles,
    maxWaitDays,
    now,
  );
  const totalLifts = data.candidates.reduce(
    (n, o) => n + o.lifts.reduce((s, l) => s + l.quantity, 0),
    0,
  );
  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6">
      <header className="rounded-2xl border bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-red-700">
          Orders &amp; Shipping · Read-only planning
        </p>
        <h1 className="mt-2 text-3xl font-semibold">
          Suggested Shipping Groups
        </h1>
        <p className="mt-3 text-slate-600">
          Compare individual ABF quotes with a coordinated delivery quote.
          Nearby destinations are a reason to compare—not a claim of savings or
          permission to delay customers.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          This screen cannot reserve inventory, fulfill orders, change queues or
          book freight. Accessories can ship separately. Recheck availability
          and confirm delivery details before booking.
        </p>
      </header>
      <form
        action="/shipping-groups"
        className="flex flex-wrap items-end gap-4 rounded-xl border bg-white p-4"
      >
        <label className="text-sm">
          Maximum distance between destinations (approx. miles)
          <input
            name="miles"
            type="number"
            min="10"
            max="500"
            defaultValue={maxMiles}
            className="mt-1 block rounded border p-2"
          />
        </label>
        <label className="text-sm">
          Do-not-delay order-age threshold (days)
          <input
            name="wait"
            type="number"
            min="1"
            max="60"
            defaultValue={maxWaitDays}
            className="mt-1 block rounded border p-2"
          />
        </label>
        <button type="submit" className="btn-primary">
          Update suggestions
        </button>
        <Link href="/orders?tab=warehouse" className="rounded border p-2">
          Warehouse
        </Link>
      </form>
      <div className="rounded-xl bg-slate-100 p-4 text-sm">
        <strong>
          {data.candidates.length} eligible orders · {totalLifts} lifts with
          warehouse coverage · {review.length} need address/geographic review
        </strong>
        <p className="mt-1">
          Eligibility follows the existing customer queue and allocation rules;
          no stock is shared between suggested orders. Incoming-only, pickup,
          payment-hold and unavailable lifts are not recommended.
        </p>
        <p className="mt-1">
          Existing queue data can be cached for up to five minutes. Addresses
          come only from the latest saved QBO invoice ShipAddr; customer
          defaults and billing addresses are never substituted. The age
          threshold is a planning warning, not a saved business policy or a
          scheduled ship date.
        </p>
      </div>
      {data.warnings.map((w) => (
        <p
          key={w}
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm"
        >
          {w}
        </p>
      ))}
      {groups.length === 0 ? (
        <p className="rounded-xl border bg-white p-6">
          No geographically verified shipping groups yet. Review missing invoice
          addresses below; no destination or availability has been invented.
        </p>
      ) : null}
      {groups.map((group, index) => {
        const lifts = group.orders.flatMap((o) => o.lifts),
          quantity = lifts.reduce((n, l) => n + l.quantity, 0);
        const allWeights = lifts.every((l) => l.unitWeight !== null);
        const weight = lifts.reduce(
          (n, l) => n + (l.unitWeight ?? 0) * l.quantity,
          0,
        );
        const ages = group.orders
          .map((o) => ageDays(o.orderDate, now))
          .filter((n): n is number => n !== null);
        return (
          <section
            key={group.orders[0].orderId}
            className="rounded-2xl border bg-white p-5"
          >
            <h2 className="text-xl font-semibold">
              {group.orders.length > 1 ? "Suggested group" : "Individual quote"}{" "}
              {index + 1} ·{" "}
              {[...new Set(group.orders.map((o) => o.address!.state))].join(
                " / ",
              )}
            </h2>
            <p className="mt-2 text-sm">
              {group.orders.length} orders · {quantity} lifts · Oldest order:{" "}
              {ages.length ? `${Math.max(...ages)} days` : "Unknown"} · Maximum
              pairwise distance: approximately {Math.ceil(group.maxMiles)} miles
            </p>
            <p className="mt-1 text-sm">
              Packed weight:{" "}
              {allWeights
                ? `${weight.toLocaleString()} lb`
                : "Incomplete—confirm all packed weights before quoting"}
            </p>
            {group.doNotDelay ? (
              <p className="mt-3 rounded bg-amber-50 p-3 text-sm font-semibold text-amber-900">
                Do not wait to fill this group: an order exceeds the age
                threshold or has ASAP instructions. Compare immediately; ship
                individually if grouping would delay it.
              </p>
            ) : null}
            <p className="my-3 text-sm text-blue-800">
              {group.orders.length > 1
                ? "Action: compare individual ABF quotes against a coordinated delivery quote, including accessorials."
                : "Action: obtain an individual quote; do not hold for more customers."}{" "}
              No quotes, savings or bookings are recorded in this first phase.
            </p>
            <div className="grid gap-3 lg:grid-cols-2">
              {group.orders.map((order) => (
                <OrderCard key={order.orderId} order={order} now={now} />
              ))}
            </div>
          </section>
        );
      })}
      <section className="rounded-2xl border bg-white p-5">
        <h2 className="text-xl font-semibold">
          Address / geographic review ({review.length})
        </h2>
        <p className="mb-4 mt-2 text-sm text-slate-600">
          These orders still retain their place and stock coverage. Fix the
          delivery address on the specific QBO invoice and use the normal
          invoice refresh. A customer default must first be confirmed as the
          correct delivery location.
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          {review.map((order) => (
            <OrderCard key={order.orderId} order={order} now={now} />
          ))}
        </div>
      </section>
      <footer className="text-xs text-slate-500">
        Approximate straight-line distances use{" "}
        <a
          className="underline"
          href="https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2025.html"
        >
          Census 2025 ZCTA representative points
        </a>
        , not road mileage or route feasibility. ZIPs absent from that dataset
        need manual review. Cross-state groups are allowed. Last read:{" "}
        {now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}{" "}
        Pacific.
      </footer>
    </main>
  );
}
