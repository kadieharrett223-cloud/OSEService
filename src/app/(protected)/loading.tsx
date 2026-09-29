/**
 * Keeps navigation responsive while a protected operational read model is loading.
 * It never reads or mutates inventory, orders, or customer demand.
 */
export default function ProtectedLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading operational data">
      <div className="h-36 animate-pulse rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="h-3 w-28 rounded bg-[#e5e7eb]" />
        <div className="mt-4 h-8 w-64 rounded bg-[#e5e7eb]" />
        <div className="mt-3 h-4 w-96 max-w-full rounded bg-[#f1f5f9]" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-sm">
        <div className="h-12 border-b border-[#eef1f4] bg-[#f8fafc]" />
        <div className="space-y-4 p-5">
          {[0, 1, 2, 3, 4].map((row) => (
            <div key={row} className="grid grid-cols-[2fr_repeat(5,1fr)] gap-4">
              <div className="h-5 rounded bg-[#eef1f4]" />
              {[0, 1, 2, 3, 4].map((cell) => <div key={cell} className="h-5 rounded bg-[#f4f6f8]" />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
