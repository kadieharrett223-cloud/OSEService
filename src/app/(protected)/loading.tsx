export default function ProtectedLoading() {
  return (
    <div className="space-y-4" aria-live="polite" aria-label="Loading page">
      <div className="h-9 w-56 animate-pulse rounded bg-[#e5e7eb]" />
      <div className="h-5 w-80 max-w-full animate-pulse rounded bg-[#edf0f4]" />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="h-28 animate-pulse rounded-lg border border-[#e5e7eb] bg-white" />
        <div className="h-28 animate-pulse rounded-lg border border-[#e5e7eb] bg-white" />
        <div className="h-28 animate-pulse rounded-lg border border-[#e5e7eb] bg-white" />
      </div>
      <div className="h-72 animate-pulse rounded-lg border border-[#e5e7eb] bg-white" />
    </div>
  );
}
