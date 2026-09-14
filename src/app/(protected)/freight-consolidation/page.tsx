import Link from "next/link";
import { FreightConsolidationMock } from "./freight-consolidation-mock";

export default function FreightConsolidationPage() {
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Warehouse Planning</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Combined shipment suggestions</h1>
            <p className="mt-2 max-w-3xl text-sm text-[#5a5a5a]">Review nearby, ready-to-ship orders before requesting a multi-stop freight quote.</p>
          </div>
          <Link href="/orders?tab=warehouse" className="btn-secondary inline-flex">Back to Warehouse</Link>
        </div>
      </section>

      <div className="rounded-xl border border-[#fde68a] bg-[#fffbeb] px-4 py-3 text-sm text-[#854d0e]">
        <span className="font-semibold">Planning mock:</span> these sample suggestions are not connected to live orders. Approving or dismissing here will not book freight, change invoices, or mark anything shipped.
      </div>

      <FreightConsolidationMock />
    </div>
  );
}
