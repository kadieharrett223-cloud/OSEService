import Link from "next/link";

export default function InventoryOverviewPage() {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Inventory</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Inventory Overview</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#5a5a5a]">
              This is the first inventory shell for the new company-wide workflow. It will eventually surface SKU availability, incoming containers, open demand, and queue visibility.
            </p>
          </div>
          <Link href="/containers" className="btn-primary inline-flex">
            View Containers
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Physical Inventory</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">Coming soon</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Open Demand</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">Coming soon</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Incoming Containers</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">Coming soon</p>
        </div>
      </div>
    </div>
  );
}
