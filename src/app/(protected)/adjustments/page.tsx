export default function AdjustmentsPage() {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Adjustments</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">
          Inventory adjustments and manual corrections will be logged here as ledger events.
        </p>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <p className="text-sm text-[#6b7280]">Adjustment history and ledger entry review will be added here.</p>
      </div>
    </div>
  );
}
