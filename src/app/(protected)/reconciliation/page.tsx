export default function ReconciliationPage() {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Reconciliation</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">
          This will compare ledger-derived inventory with stored values and active container quantities so discrepancies are visible.
        </p>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <p className="text-sm text-[#6b7280]">Reconciliation views and discrepancy reporting will be added here.</p>
      </div>
    </div>
  );
}
