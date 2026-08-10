export default function ShippingReviewPage() {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Shipping Review</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">
          Paid QuickBooks invoices will enter this queue first. Shipping can review, approve, hold, or remove lines before they become sold/open demand.
        </p>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <p className="text-sm text-[#6b7280]">Line-level review workflow will appear here.</p>
      </div>
    </div>
  );
}
