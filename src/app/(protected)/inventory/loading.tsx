export default function InventoryLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-4 rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
      <h1 className="text-3xl font-semibold text-[#111827]">Inventory</h1>
      <p className="text-sm text-[#64748b]">Loading stock and customer lists…</p>
      <div aria-hidden="true" className="animate-pulse space-y-3">
        {[0, 1, 2, 3, 4].map(row => <div key={row} className="h-12 rounded bg-[#eef2f6]" />)}
      </div>
    </div>
  );
}
