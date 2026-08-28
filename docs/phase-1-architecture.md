# Phase 1 Architecture

## Scope
Phase 1 implements only internal customer service case tracking:

- Employee login
- Access-code login
- Shared code with per-person login history
- Customer/case creation
- Case type routing (General, Warranty)
- Status and priority updates
- New cases auto-start as In Progress at creation
- Case detail status is managed from a single Status control (Case Workflow section); issue-details edits no longer mutate status
- Completed/Closed are treated as Resolved in operator-facing UI labels
- Workflow event buttons append timeline entries only; they do not mutate case status
- On case details, when status is Resolved the priority chip is replaced with a green Complete badge for at-a-glance closure state
- Internal/customer notes
- Attachment upload metadata and secure storage
- Replacement part tracking
- Immutable activity timeline entries
- Workflow action controls that append timeline events (customer contacted, waiting states, warranty/parts/tracking updates)
- Search and filtering for operations
- Dashboard-level recent-case filter menu supports All, In Progress, and Resolved views
- Dashboard recent-case list shows a green Complete badge when a case status is Resolved/Completed/Closed
- Cases list now includes explicit sort controls (updated newest/oldest, priority high-low, status A-Z)
- Cases list includes a dedicated right-side Open action button per row for direct case access
- Sidebar workflow menu no longer includes warranty shortcut links
- Menu/list status color semantics: In Progress is red, while Resolved/Completed/Closed are green
- Dashboard High Priority metric excludes Resolved/Completed/Closed cases
- Protected app shell now uses full-width layout so the left sidebar is flush to the viewport edge on wide displays
- Sidebar navigation text size increased for better readability in operations workflows
- Case details customer card now surfaces both shipping and billing addresses on the left with QuickBooks snapshot fallbacks; invoice-side billing line removed
- Customer phone/email are no longer shown as separate fields in case/create customer cards; shipping address line now carries contact context (Phone/Email) when available
- Existing case details now allow editing shipping address directly in the app with autosave; edits update local customer data only and do not write back to QuickBooks
- Archived/completed case view with reopen support
- Multi-file attachment gallery with upload, download, and delete controls
- Workflow-first create-case workspace with dedicated sections for Customer Information, Issue Details, Photos/Attachments, Timeline/Notes, and Resolution/Status
- Case details timeline defaults to the 5 most recent events with a View All toggle for full history
- QuickBooks-prefilled customer/invoice card on intake with editable local shipping address (saved in app only; no QuickBooks writeback) and editable customer notes
- Create-time attachment queue previews with filename, size, selected time, selected by, and remove control before submit
- Create-time internal notes queue that is converted into case notes and case_activity timeline rows on save

## Operational Overlay (Current)

The app now includes an additive operations layer while preserving the original service system.

- Main Dashboard is now company-wide: Inventory, Orders, Containers, Service widgets, plus cross-domain Recent Activity links.
- Service-only dashboard metrics were moved into the Service area (`/cases`) as a Service Snapshot section.
- Inventory is now a sales lookup workspace: SKU/product search, on-floor/sold/available/incoming visibility, next ETA, and an expandable customer queue per SKU.
- Orders is the shipping operations workflow. Order detail is a single fulfillment worksheet (Item, Qty, Coming From, Availability, Fulfillment, Action) with per-line Manage expansion for assignment, partial shipment, and item notes.
- Every remaining mapped physical order line is selectable in that worksheet, regardless of whether its current source is Warehouse, Container, unassigned, Dropship, or Other. Source assignment continues to control fulfillment-record and inventory behavior; it never controls selection eligibility. When the canonical QuickBooks parent has an active same-invoice sibling with a matching preserved physical line, the existing canonical invoice row remains a single row and can select that sibling-owned line for fulfillment. A submission accepts lines from one parent only and creates its shipment, fulfillment, inventory, and activity evidence on that owner; it never copies, moves, or merges the sibling line into QuickBooks.
- Orders list shipment totals are a fresh server-side projection of canonical physical fulfillment lines. The normal and archived tabs use the same ordered, shipped, and remaining totals so completed orders do not show stale open quantities after reconciliation or fulfillment.
- Orders search runs against the lightweight cached Orders projection across every lifecycle tab. The projection classifies every active parent independently; it must not select or suppress a QBO/OLD_ERP sibling until a logical-order merger safely represents all parent evidence. A unique exact invoice search routes to its current lifecycle tab; partial/customer searches show each matching order with its lifecycle, and true invoice collisions with different source identities remain separate customer records. The 60-second projection cache is tagged and lifecycle-changing Server Actions invalidate the tag before redirecting.
- When QuickBooks and OLD_ERP parents represent the same invoice, the QuickBooks parent is canonical and the OLD_ERP parent is retired only by setting `duplicate_of_order_id`. Duplicate retirement preserves all order-line quantities, fulfillment and shipment history, inventory transactions, allocations, and container values; it writes an audit event and uses positions-only queue renumbering for affected products.
- `scripts/audit-active-duplicate-parents.mjs` is a read-only global safeguard for active QBO/OLD_ERP siblings. It classifies candidates as `SAFE_DUPLICATE`, `CONFLICTING_EVIDENCE`, or `CUSTOMER_COLLISION`; the report never applies bulk corrections, and only an individually approved guarded retirement may update a stale parent.
- `scripts/audit-duplicate-parent-operational-impact.mjs` is a read-only follow-up for `CONFLICTING_EVIDENCE` siblings. It separates conflicts that can still affect active demand, warehouse work, partial fulfillment, or allocations from historical/non-operational records, using the same both-parents-operational rule as ERP Health. It never merges, retires, or otherwise changes either parent.
- `scripts/audit-duplicate-parent-obligation-comparison.mjs` is a read-only, per-pair evidence report. It compares shared source identity, customer identity, SKU/product-level ordered and remaining quantities, fulfillment-ledger quantity, shipment quantity, and active allocations. QuickBooks remains canonical for a shared QBO identity; only an exact customer and SKU/ordered-quantity match is reported as the same real obligation. Differing or unproven obligations remain preserved, and even exact matches require separate evidence review before a parent can be retired.
- `scripts/review-operational-duplicate-parent-candidates.mjs` is a read-only review locked to the currently operational same-obligation candidates. It compares approved and remaining demand in addition to original ordered quantity, then requires the OLD_ERP parent to have no separate fulfillment, shipment, allocation, or inventory evidence before it can be labeled `SAFE_TO_RETIRE_STALE_PARENT`. Any active quantity divergence remains `KEEP_BOTH`.
- `scripts/audit-operational-parent-divergence-origin.mjs` is a read-only source trace for those preserved operational candidates. It follows QBO invoice lines through their SKU/product mapping and OLD_ERP source records, reproduces the canonical identity bridge, and reports the single projected Customer List/Committed quantity. An OLD_ERP line mapped unambiguously to a real QBO line supplies an alternate state representation and is never summed as additional demand.
- `scripts/audit-operational-duplicate-parent-demand.mjs` is a read-only reconciliation across every currently operational QBO/OLD_ERP conflict. It checks each physical QBO line identity against the one canonically selected open quantity after shared proven fulfillment, and checks that explicitly reviewed terminal obligations do not reappear. Its report separates real eligible-demand quantity mismatches from QBO source lines that remain outside Customer List because they are not yet canonical-eligible (`PENDING_REVIEW` or unrepresented); the latter are intake/review gaps, not duplicate-parent projection errors. It never changes QBO intake, orders, lines, allocations, fulfillment, shipments, or inventory.
- `scripts/audit-duplicate-parent-intake-gaps.mjs` is a read-only follow-up for QBO source lines excluded as pending or unrepresented by that reconciliation. It classifies each source line using payment status, physical-line policy, product/alias mapping, reviewed-terminal state, mapping-review evidence, and any existing line representation. Paid, mapped physical lines with only zero-approved `PENDING_REVIEW` representations or no representation are reported as activation-review candidates; unmapped paid physical lines are reported as mapping-review candidates. The audit never activates an order, changes source QBO data, or writes queue, fulfillment, shipment, allocation, or inventory records.
- ERP Health renders the live historical paid-QBO intake review population as a dedicated QBO-line review table. Mapped rows offer an explicit per-line decision: `Approve / Import Demand`, `Already satisfied / Do not import`, `Duplicate / Keep out`, or `Cancelled / Closed`; unmapped rows link to Product Mapping Review and cannot create demand. The Server Action trusts only the submitted QBO line UUID, then re-reads the QBO invoice/line, payment status, physical-line rule, product mapping, exact ERP representation, active terminal resolutions, open manual-duplicate review, and void state before an approval. Approval changes only one exact pending representation or creates one QBO parent and one exact physical line, and it never activates sibling invoice lines. It creates no shipment, fulfillment, allocation, or inventory records. Non-import choices create an active source-specific obligation resolution and every choice is recorded in `historical_qbo_intake_reviews`; normal automatic forward intake remains independently cutoff-controlled.
- For an approved representation that maps unambiguously to a QBO invoice line, canonical Customer List demand uses the QBO line's source quantity rather than that representation's local approved quantity. Proven fulfillment is still shared by logical identity before calculating the open remainder. This prevents a partial, stale, or oversized OLD_ERP sibling from undercounting or inflating the real obligation; QBO rows with no approved representation retain their intake state and are not activated by this rule.
- Orders list and lookup project active same-invoice parents as one logical row routed through the canonical QuickBooks parent. The projection combines every active sibling line before calculating search, lifecycle tabs, ordered/shipped/remaining totals, and status, so list results agree with the canonical detail page. It never moves, retires, or deletes underlying parents or lines. `scripts/audit-orders-projection-canonicalization.mjs` evaluates every active parent and exits nonzero if any physical line is absent from its logical row; `scripts/snapshot-operational-data-readonly.mjs` protects table fingerprints. Both are read-only release gates.
- Canonical order-detail item rows use the same active sibling line set as the totals. When QBO and OLD_ERP lines represent one invoice item, a fulfilled matching line takes precedence over an unfulfilled duplicate, so the visible item status cannot disagree with its shipment history or the order-level fulfilled count.
- One fulfillment submission can create owner-level shipment records for more than one active same-invoice parent because the shipment RPC enforces physical line ownership. Order detail groups those records by their shared fulfillment idempotency submission key and renders one customer shipment with all selected items, carrier, tracking, date, and notes. The underlying shipment IDs, parent ownership, fulfillment rows, and inventory transactions remain unchanged.
- A saved `DROPSHIP` or `OTHER` source is displayed from the operational line itself, rather than inferred from warehouse allocations. Customer commitment is derived from canonical physical ordered demand minus fulfilled/cancelled demand; it is not maintained by the historical `SOLD` inventory bucket. Warehouse/Floor fulfillment records exact `ON_FLOOR -qty` only. Dropship/Other fulfillment records customer completion without Olympic inventory transactions. The historical `SOLD` ledger is preserved unchanged and is not an operational inventory input.
- After a shipping session, run `node --env-file=.env.local scripts/audit-recent-fulfillment-integrity.mjs --since=<ISO timestamp>`. This read-only audit verifies each shipment line has matching fulfillment evidence, Warehouse/Floor lines recorded exact `ON_FLOOR -qty` with no other inventory event, Dropship/Other lines recorded no inventory events, and remaining customer demand matches the fulfillment ledger. It exits nonzero on any mismatch.
- `npm run audit:archived-orders` is a production-backed, read-only Orders health gate. It audits every logical Archived order across active same-invoice siblings using canonical physical items only. A clean order has per-item `ordered = fulfilled = shipped`, zero remaining and customer-list demand, and no active warehouse reservation or container allocation. Historical `OTHER` completion with explicit fulfillment evidence but no modern shipment is reported as a warning rather than silently treated as a normal shipment. The report is written to `tmp/import-reports/archived-order-integrity-audit.json`; it never changes orders, queue positions, allocations, containers, shipment history, or inventory transactions and exits nonzero for non-clean orders.
- `npm run verify:orders-projection` is the deterministic release-blocking regression gate for the Orders projection. It protects active same-invoice parents and their demand, warehouse, partial-shipment, fulfillment, shipment, customer-list, queue, reservation, container, inventory, cancellation, and archive evidence from being suppressed before a future logical-order merger represents that evidence safely.
- Any change to order identity, parent selection, canonicalization, lifecycle classification, OLD_ERP/QBO bridging, customer demand, or duplicate handling must run both `npm run verify:orders-projection` and the production-backed `scripts/audit-orders-projection-canonicalization.mjs` before push. Unexplained lost evidence in either gate blocks deployment.
- `scripts/review-safe-duplicate-parent-candidates.mjs` performs a second read-only ledger review for approved candidates. It verifies identity, canonical fulfillment coverage, shipment and fulfillment evidence, reservations, queue state, container allocations, inventory transactions, and customer-list demand before classifying a parent as `READY_FOR_APPROVAL` or `NEEDS_MANUAL_REVIEW`.
- ERP Health exposes `PARENT_EVIDENCE_CONFLICT` for active QBO/OLD_ERP siblings with divergent product, quantity, or fulfillment evidence. Each finding shows the preserved parent IDs and comparison evidence with View Order and Investigate links; it intentionally has no automatic retirement control.
- Orders also includes a bulk backlog upload workspace at `/orders/import` that wraps the existing OLD_ERP backlog importer with preview/apply controls and local report visibility.
- Bulk backlog upload now checks for duplicate invoice numbers already present in `shipping_orders` before apply and gives staff a choice to proceed against the existing orders or skip selected duplicates.
- Freight Claims is a dedicated operational view over `Freight Damage` cases so staff can track claim status, priority, assignment, and resolution without leaving the shipping workflow.
- Container-linked lines read container number/status/ETA directly from container records, so order availability updates automatically when container ETAs change.
- Open approved/unfulfilled lines now calculate Suggested Source + Suggested ETA automatically from queue-aware inventory logic (warehouse stock first, then first-fit inbound container by ETA after live allocation deductions).
- Suggested source is advisory only. Live `inventory_allocations` rows are created only when Shipping confirms assignment; ETA is not persisted on order lines.
- Schedule is a dedicated shared shipping calendar view backed by `shipping_orders.promised_ship_date` and linked to order detail.
- Containers remains inbound supply and ETA workflow.
- Container detail now includes a customer-impact acceptance step: before marking a container received, operators see the affected customer/invoice lines, a confirmation summary, and can run one action to mark only applicable allocated lines as `IN_WAREHOUSE` based on available received quantity for that container.
- Cancelled containers retain their historical container and line records under `containers.lifecycle_status = 'CANCELLED'`; because canonical incoming coverage includes only `ORDERED`, `PRODUCTION`, and `INBOUND`, cancellation removes their remaining supply from forecasts without changing `ON_FLOOR`, `SOLD`, customer demand, fulfillment, or shipment history. `scripts/apply-cancelled-containers-240-241.mjs` is the one-purpose audited correction for the approved historical cancellation of Containers 240 and 241. It requires their exact unreceived manifests and no receipt inventory evidence, releases only the approved Joe Sciarra Container 241 reservation, writes container audit records, and verifies reruns without a second mutation. Forecast coverage is then recalculated by the shared canonical coverage reader, never by manually moving customers to a replacement container.
- Receipt safeguard: when `received_qty` exists it is always used; if no received quantities are entered, operators must explicitly confirm a full-container receipt before the system uses full container quantities to determine eligible order lines.
- One-time OLD_ERP opening-data import is supported for active `ON_ORDER` containers only. Import writes container/container-line baseline records with source metadata (`source_system`, `source_record_id`, `source_key`) and does not execute receiving, inventory ledger movements, assignment changes, or customer shipping transitions.
- My Sales is a read-only salesperson status view over the same shipping data (queue, assignment, ETA, tracking) without shipping controls.
- Service remains case/install-focused workflow.
- Settings is admin-gated: an admin code unlock (same validator used by Delete Case) is required before viewing login activity, managing access users, or running QuickBooks connect/sync/disconnect actions.

Out of scope for Phase 1:

- QuickBooks writeback or accounting edits
- CRM/sales pipeline features
- Inventory management workflows

## Request/Data Flow

1. User enters full name and shared access code on /enter-code.
2. Server validates shared code, resolves/creates access_users identity, and writes access_login_events.
3. UI submits Server Actions (Next.js) for writes.
4. Server Actions write to Supabase Postgres tables.
5. Activity rows are appended to case_activity.
6. Attachments are uploaded to private Supabase Storage bucket case-attachments.
7. Case actions and uploads append timeline rows to case_activity automatically.
8. Access is enforced by server-side session cookies.
9. Create-case resolution fields (status, assignee, next action, ETA, tracking) are persisted at case creation and reflected in timeline/internal notes metadata.

## Main Tables

- profiles
- customers
- quickbooks_invoices (placeholder for Phase 2 links)
- customer_service_cases
- case_notes
- case_attachments
- case_activity
- replacement_parts
- access_users
- access_login_events

## Security Model

- Supabase Auth user login is not used.
- Shared access code is configured via environment variable.
- Access users are managed in app settings.
- Service role keys are not used in browser code.
- Browser never receives service role key or access code table credentials.

## Status Set

- New
- Waiting for Customer
- Under Review
- Parts Needed
- Parts Ordered
- Parts Shipped
- Service Scheduled
- Resolved
- Closed
