export default function ProtectedLoading() {
  return (
    <div className="space-y-4" aria-live="polite" aria-busy="true" aria-label="Loading page">
      <section className="animate-pulse rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="h-3 w-32 rounded bg-[#f0c6c9]" />
        <div className="mt-4 h-9 w-64 max-w-full rounded bg-[#e5e7eb]" />
        <div className="mt-3 h-4 w-[32rem] max-w-full rounded bg-[#edf0f4]" />
      </section>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-28 animate-pulse rounded-xl border border-[#e5e7eb] bg-white shadow-sm" />)}
      </div>
      <div className="animate-pulse rounded-xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
        <div className="h-7 w-44 rounded bg-[#e5e7eb]" />
        <div className="mt-5 space-y-3">{[0, 1, 2, 3, 4].map((row) => <div key={row} className="h-12 rounded-lg bg-[#f1f3f6]" />)}</div>
      </div>
    </div>
  );
}
