import Link from "next/link";
import { Fragment } from "react";
import { createProductAction } from "@/app/(protected)/inventory/actions";
import { AddProductModal } from "@/app/(protected)/inventory/add-product-modal";
import { AdminModeToggle } from "@/app/(protected)/inventory/admin-mode-toggle";
import { AdminRowEditor } from "@/app/(protected)/inventory/admin-row-editor";
import { CustomerDemandDropdown } from "@/app/(protected)/inventory/customer-demand-dropdown";
import { DisplayOrderButton } from "@/app/(protected)/inventory/display-order-button";
import { IncomingDropdown } from "@/app/(protected)/inventory/incoming-dropdown";
import { requireUser } from "@/lib/auth";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { loadInventoryDisplayModel } from "@/lib/inventory/inventory-display-model";
import { formatPackageDimensions, formatPackageWeight, type PackageDimensions } from "@/lib/products/package-dimensions";

function formatNumber(value: number) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  if (Number.isInteger(rounded)) return new Intl.NumberFormat("en-US").format(rounded);
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rounded);
}


function formatPackageSummary(dimensions: PackageDimensions | null) {
  if (!dimensions) return null;
  return [formatPackageDimensions(dimensions), formatPackageWeight(dimensions)].filter(Boolean).join(" · ") || null;
}


const UNSORTED_GROUP = "Other / Unsorted";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; group?: string; page?: string; mapError?: string; mapMessage?: string }>;
}) {
  const currentUser = await requireUser();
  const adminMode = await isAdminUnlockedForUser(currentUser.id);
  const params = await searchParams;
  const q = String(params.q ?? "").trim().toLowerCase();
  const selectedGroup = String(params.group ?? "").trim();
  const requestedPage = Math.max(1, Number.parseInt(String(params.page ?? "1"), 10) || 1);
  const mapError = String(params.mapError ?? "").trim();
  const mapMessage = String(params.mapMessage ?? "").trim();
  const { displayRows, groupNames } = await loadInventoryDisplayModel(q);

  const allSections: Array<{ name: string; rows: typeof displayRows }> = [];
  for (const row of displayRows) {
    const current = allSections[allSections.length - 1];
    if (current && current.name === row.group) current.rows.push(row);
    else allSections.push({ name: row.group, rows: [row] });
  }

  // Rendering every catalog row also serializes every open customer list into the browser.
  // Keep all stock arithmetic above intact, but render a bounded slice until the user chooses
  // a group or searches. This removes thousands of hidden interactive nodes from normal page
  // navigation without excluding any product from lookup.
  const matchingRows = selectedGroup && !q
    ? displayRows.filter((row) => row.group === selectedGroup)
    : displayRows;
  // Inventory rows include customer-list controls and several availability
  // calculations. A smaller default keeps ordinary navigation responsive;
  // search and the group picker still expose the entire catalog.
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(matchingRows.length / pageSize));
  const currentPage = Math.min(requestedPage, pageCount);
  const visibleRows = matchingRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const visibleSections: Array<{ name: string; rows: typeof visibleRows }> = [];
  for (const row of visibleRows) {
    const current = visibleSections[visibleSections.length - 1];
    if (current && current.name === row.group) current.rows.push(row);
    else visibleSections.push({ name: row.group, rows: [row] });
  }
  const inventoryHref = (next: { group?: string; page?: number }) => {
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (next.group) query.set("group", next.group);
    if (next.page && next.page > 1) query.set("page", String(next.page));
    const value = query.toString();
    return value ? `/inventory?${value}` : "/inventory";
  };
  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#6b7280]">Inventory</p>
            <h1 className="mt-1 text-3xl font-semibold text-[#111827]">Lift Availability</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">Search product availability, incoming containers/ETA, and approved customer queue by SKU.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <AdminModeToggle unlocked={adminMode} />
            <Link href="/product-mappings" className="btn-primary">Map Unmapped SKUs</Link>
            {adminMode ? <Link href="/inventory/audit?sku=ALL&period=week" prefetch={false} className="btn-secondary">Print Audit History</Link> : null}
            <AddProductModal createAction={createProductAction} groups={groupNames.filter((group) => group !== UNSORTED_GROUP)} />
          </div>
        </div>
      </div>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <form className="space-y-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Product lookup</p>
            <label htmlFor="inventory-search" className="mt-1 block text-sm font-semibold text-[#334155]">Find an item by name or SKU</label>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              id="inventory-search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search item name or SKU..."
              className="input min-w-[260px] flex-1 text-base"
            />
            <button className="btn-primary" type="submit">Lookup</button>
            <Link className="btn-ghost" href="/inventory">Clear</Link>
          </div>
        </form>
      </section>

      <nav aria-label="Inventory groups" className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Groups</span>
          {allSections.map((section) => (
            <a
              key={section.name}
              href={inventoryHref({ group: section.name })}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${selectedGroup === section.name && !q ? "border-[#93c5fd] bg-[#eff6ff] text-[#1d4ed8]" : "border-[#dbe3ee] bg-[#f8fafc] text-[#334155] hover:border-[#93c5fd] hover:bg-[#eff6ff]"}`}
            >
              {section.name} <span className="font-normal text-[#64748b]">({section.rows.length})</span>
            </a>
          ))}
        </div>
      </nav>

      {mapError ? <p className="rounded-md border border-[#fecaca] bg-[#fff1f2] p-3 text-sm text-[#991b1b]">{mapError}</p> : null}
      {mapMessage ? <p className="rounded-md border border-[#bbf7d0] bg-[#f0fdf4] p-3 text-sm text-[#166534]">{mapMessage}</p> : null}

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="max-w-full overflow-x-auto md:overflow-visible">
          <table className="w-full min-w-[976px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[280px]" />
              <col className="w-[82px]" />
              <col className="w-[78px]" />
              <col className="w-[108px]" />
              <col className="w-[92px]" />
              <col className="w-[128px]" />
              <col className="w-[156px]" />
            </colgroup>
            <thead className="bg-white shadow-[0_1px_0_0_#dbe3ee]">
              <tr className="border-b border-[#eceff3] bg-white text-xs uppercase tracking-[0.08em] text-[#64748b]">
                <th className="sticky top-[61px] z-30 bg-white px-2 py-2.5">Item</th>
                <th className="sticky top-[61px] z-30 bg-white px-2 py-2.5">On Floor</th>
                <th className="sticky top-[61px] z-30 bg-white px-2 py-2.5">Sold</th>
                <th className="sticky top-[61px] z-30 bg-white px-2 py-2.5">Available Now</th>
                <th className="sticky top-[61px] z-30 bg-white px-2 py-2.5">Incoming</th>
                <th className="sticky top-[61px] z-30 bg-white px-2 py-2.5">Next Arrival</th>
                <th className="sticky top-[61px] z-30 bg-white px-2 py-2.5">Customer List</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-10 text-center text-[#6b7280]">No products match this search.</td>
                </tr>
              ) : (
                visibleSections.map((section) => (
                  <Fragment key={section.name}>
                    <tr id={`group-${section.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="scroll-mt-24 border-b border-[#e2e8f0] bg-[#f8fafc]">
                      <th colSpan={7} scope="colgroup" className="px-2 py-2 text-left text-xs font-semibold uppercase tracking-[0.08em] text-[#475569]">
                        {section.name}
                        <span className="ml-2 font-normal normal-case tracking-normal text-[#94a3b8]">{section.rows.length}</span>
                      </th>
                    </tr>
                    {section.rows.map((row) => (
                      <tr key={row.productId} className="border-b border-[#f1f5f9] align-top">
                    <td className="px-2 py-3">
                      <div className="line-clamp-2 max-w-[260px] break-words font-semibold leading-5 text-[#111827]" title={row.productName}>{row.productName}</div>
                      {(() => {
                        const packageText = formatPackageSummary(row.packageDimensions);
                        return packageText ? <div className="mt-1 text-xs font-medium text-[#64748b]">{packageText}</div> : (
                          <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-[#64748b]">
                            {row.manufacturer ? <span className="rounded border border-[#e2e8f0] bg-[#f8fafc] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[#475569]">{row.manufacturer}</span> : null}
                            <span>SKU {row.sku}</span>
                          </div>
                        );
                      })()}
                      {adminMode ? (
                        <>
                          <AdminRowEditor
                            productId={row.productId}
                            stockProductIds={row.stockProductIds}
                            sku={row.sku}
                            productName={row.productName}
                            storedName={row.storedName}
                            onFloor={row.onFloor}
                          />
                          <Link
                            href={`/inventory/audit?sku=${encodeURIComponent(row.sku)}`}
                            prefetch={false}
                            className="mt-2 inline-flex rounded border border-[#bfdbfe] bg-[#eff6ff] px-2 py-1 text-xs font-semibold text-[#1d4ed8] hover:bg-[#dbeafe]"
                          >
                            Audit
                          </Link>
                        </>
                      ) : null}
                      <DisplayOrderButton
                        productIds={row.productIds}
                        productName={row.productName}
                        sku={row.sku}
                        group={row.group}
                        sortOrder={row.sortOrder === Number.MAX_SAFE_INTEGER ? null : row.sortOrder}
                        groups={groupNames}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-3">{formatNumber(row.onFloor)}</td>
                    <td className="whitespace-nowrap px-2 py-3">{formatNumber(row.openDemand)}</td>
                    <td className="whitespace-nowrap px-2 py-3 font-semibold text-[#16a34a]">
                      {formatNumber(row.availableNow)}
                      {row.backorderedNow > 0 ? (
                        <div
                          className="mt-1 text-xs font-semibold text-[#b45309]"
                          title="Open customer quantity not covered by stock on floor. Incoming stock is not available yet."
                        >
                          Backordered {formatNumber(row.backorderedNow)}
                        </div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3">
                      <IncomingDropdown
                        total={formatNumber(row.incoming)}
                        containers={row.incomingContainers}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-3">{row.nextEta}</td>
                    <td className="whitespace-nowrap px-2 py-3">
                      <CustomerDemandDropdown
                        productName={row.productName}
                        sku={row.sku}
                        openQuantity={formatNumber(row.openDemand)}
                        customerQueue={row.customerQueue}
                        adminMode={adminMode}
                      />
                    </td>
                      </tr>
                    ))}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <nav aria-label="Inventory pagination" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e5e7eb] bg-white px-4 py-3 text-sm shadow-sm">
        <p className="text-[#64748b]">
          Showing {matchingRows.length ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, matchingRows.length)} of {matchingRows.length} items{selectedGroup && !q ? ` in ${selectedGroup}` : ""}.
        </p>
        <div className="flex items-center gap-2">
          {selectedGroup && !q ? <Link className="btn-ghost" href="/inventory">All groups</Link> : null}
          {currentPage > 1 ? <Link className="btn-secondary" href={inventoryHref({ group: selectedGroup || undefined, page: currentPage - 1 })}>Previous</Link> : null}
          <span className="text-xs font-semibold text-[#475569]">Page {currentPage} of {pageCount}</span>
          {currentPage < pageCount ? <Link className="btn-secondary" href={inventoryHref({ group: selectedGroup || undefined, page: currentPage + 1 })}>Next</Link> : null}
        </div>
      </nav>
    </div>
  );
}
