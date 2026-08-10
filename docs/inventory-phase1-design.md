# Inventory Expansion Design for OSE Service Tracker

## Scope and guardrails

This proposal is an additive expansion of the current service-tracking application. It does not replace or remove the existing Service Tracker experience.

The current service routes remain intact at their existing URLs:

- /dashboard
- /cases
- /cases/new
- /cases/completed
- /installation
- /installation/new
- /settings

The new inventory and shipping work is layered on top of the existing app shell and Supabase schema.

---

## 1. Current architecture and schema map

### Current application structure

- App shell and navigation live in [src/app/(protected)/layout.tsx](src/app/(protected)/layout.tsx) and [src/app/(protected)/sidebar-nav.tsx](src/app/(protected)/sidebar-nav.tsx).
- Service pages are implemented in the protected app route tree under [src/app/(protected)](src/app/(protected)).
- Server actions for service workflow are in [src/app/(protected)/cases/actions.ts](src/app/(protected)/cases/actions.ts), [src/app/(protected)/cases/[id]/actions.ts](src/app/(protected)/cases/[id]/actions.ts), and [src/app/(protected)/installation/actions.ts](src/app/(protected)/installation/actions.ts).
- QuickBooks integration already exists in [src/lib/quickbooks/integration.ts](src/lib/quickbooks/integration.ts) and the callback/connect routes under [src/app/api/integrations/quickbooks](src/app/api/integrations/quickbooks).
- Authentication uses the access-user flow defined in [src/lib/auth.ts](src/lib/auth.ts) and [src/lib/session.ts](src/lib/session.ts).

### Current Supabase schema baseline

The existing service schema is created by:

- [supabase/migrations/202607300001_phase1_customer_service.sql](supabase/migrations/202607300001_phase1_customer_service.sql)
- [supabase/migrations/202607300002_access_code_auth.sql](supabase/migrations/202607300002_access_code_auth.sql)
- [supabase/migrations/202607300003_case_workflow_updates.sql](supabase/migrations/202607300003_case_workflow_updates.sql)
- [supabase/migrations/202607300004_quickbooks_connections.sql](supabase/migrations/202607300004_quickbooks_connections.sql)
- [supabase/migrations/202608030001_installation_workflow.sql](supabase/migrations/202608030001_installation_workflow.sql)

Key existing tables:

- public.customers
- public.quickbooks_invoices
- public.customer_service_cases
- public.case_notes
- public.case_attachments
- public.case_activity
- public.replacement_parts
- public.installation_jobs
- public.installation_notes
- public.installation_photos
- public.quickbooks_connections
- public.access_users

### Architectural fit

This is a good foundation for an additive ERP layer because:

- the app already uses UUID-backed records;
- QuickBooks snapshots are already stored separately from operational service records;
- the service tracker is already routed through server actions and Supabase;
- the current sidebar is already modular and can host new groups without removing service pages.

---

## 2. Exact proposed schema additions

The first phase should add new tables without altering or renaming the existing service tables.

### Core product and mapping tables

```sql
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  canonical_name text not null,
  description text,
  status text not null default 'Active' check (status in ('Active', 'Inactive', 'Discontinued')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  alias text not null,
  source_type text not null default 'manual' check (source_type in ('manual', 'qbo', 'import')),
  source_ref text,
  created_at timestamptz not null default now()
);
```

### QuickBooks line-level records

```sql
create table if not exists public.qbo_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  qbo_invoice_id uuid not null references public.quickbooks_invoices(id) on delete cascade,
  qbo_line_id text,
  qbo_item_id text,
  qbo_sku text,
  source_description text,
  product_id uuid references public.products(id) on delete set null,
  mapping_status text not null default 'Pending Review' check (mapping_status in ('Pending Review', 'Mapped', 'Mapping Review', 'Removed')),
  ordered_qty numeric(12,2) not null default 0,
  unit_price numeric(12,2),
  line_total numeric(12,2),
  approval_status text not null default 'Pending Review' check (approval_status in ('Pending Review', 'Approved', 'Hold', 'Partial', 'In Warehouse', 'Ready', 'Fulfilled', 'Removed', 'Cancelled')),
  queue_status text not null default 'Waiting' check (queue_status in ('Waiting', 'Queued', 'In Warehouse', 'Ready', 'Fulfilled', 'Hold')),
  warehouse_status text not null default 'Pending Review' check (warehouse_status in ('Pending Review', 'Approved', 'On Floor', 'Assigned to Inbound', 'In Warehouse', 'Picked', 'Ready to Ship', 'Partially Fulfilled', 'Fulfilled', 'Hold')),
  fulfillment_status text not null default 'Pending' check (fulfillment_status in ('Pending', 'Partially Fulfilled', 'Fulfilled', 'Cancelled')),
  allocation_status text not null default 'Unallocated' check (allocation_status in ('Unallocated', 'Allocated', 'Partially Allocated', 'Released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### Shipping and queue entities

```sql
create table if not exists public.shipping_orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  source_invoice_id uuid references public.quickbooks_invoices(id) on delete set null,
  order_number text,
  order_type text not null default 'Customer' check (order_type in ('Customer', 'Internal', 'Transfer')),
  status text not null default 'Pending Review' check (status in ('Pending Review', 'Approved', 'Hold', 'Partial', 'Fulfilled', 'Cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shipping_order_lines (
  id uuid primary key default gen_random_uuid(),
  shipping_order_id uuid not null references public.shipping_orders(id) on delete cascade,
  qbo_invoice_line_id uuid references public.qbo_invoice_lines(id) on delete set null,
  product_id uuid not null references public.products(id),
  ordered_qty numeric(12,2) not null default 0,
  approved_qty numeric(12,2) not null default 0,
  fulfilled_qty numeric(12,2) not null default 0,
  cancelled_qty numeric(12,2) not null default 0,
  remaining_qty numeric(12,2) not null default 0,
  approval_status text not null default 'Pending Review' check (approval_status in ('Pending Review', 'Approved', 'Hold', 'Partial', 'Fulfilled', 'Removed', 'Cancelled')),
  priority text not null default 'Normal' check (priority in ('Low', 'Normal', 'High', 'Critical')),
  queue_position integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_queue_entries (
  id uuid primary key default gen_random_uuid(),
  shipping_order_line_id uuid not null references public.shipping_order_lines(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity numeric(12,2) not null default 0,
  remaining_qty numeric(12,2) not null default 0,
  queue_position integer not null,
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
```

### Containers and inventory ledger

```sql
create table if not exists public.containers (
  id uuid primary key default gen_random_uuid(),
  container_number text not null unique,
  supplier text,
  order_date date,
  entered_date date,
  deposit_amount numeric(12,2),
  deposit_date date,
  final_payment_amount numeric(12,2),
  final_payment_date date,
  remaining_balance numeric(12,2),
  payment_status text not null default 'Pending' check (payment_status in ('Pending', 'Partially Paid', 'Paid', 'Cancelled')),
  production_status text not null default 'Planned' check (production_status in ('Planned', 'In Production', 'Complete', 'Delayed')),
  tracking_number text,
  eta_estimated_date date,
  eta_confirmed_date date,
  port_date date,
  status text not null default 'Created' check (status in ('Created', 'In Production', 'Inbound', 'Received', 'Closed', 'Cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.container_lines (
  id uuid primary key default gen_random_uuid(),
  container_id uuid not null references public.containers(id) on delete cascade,
  product_id uuid not null references public.products(id),
  ordered_qty numeric(12,2) not null default 0,
  received_qty numeric(12,2) not null default 0,
  on_order_qty numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  bucket text not null check (bucket in ('SOLD', 'ON_FLOOR', 'ON_ORDER', 'INCOMING_AVAILABLE')),
  delta numeric(12,2) not null,
  reason text not null,
  source_type text not null,
  source_id uuid,
  container_id uuid references public.containers(id) on delete set null,
  shipping_order_line_id uuid references public.shipping_order_lines(id) on delete set null,
  actor_id uuid references public.access_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_allocations (
  id uuid primary key default gen_random_uuid(),
  shipping_order_line_id uuid not null references public.shipping_order_lines(id) on delete cascade,
  product_id uuid not null references public.products(id),
  quantity numeric(12,2) not null default 0,
  allocation_status text not null default 'Allocated' check (allocation_status in ('Allocated', 'Released', 'Reassigned')),
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  sold_qty numeric(12,2) not null default 0,
  on_floor_qty numeric(12,2) not null default 0,
  on_order_qty numeric(12,2) not null default 0,
  snapshot_at timestamptz not null default now(),
  source text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid,
  action text not null,
  actor_id uuid references public.access_users(id) on delete set null,
  details jsonb,
  created_at timestamptz not null default now()
);
```

### Notes on the design

- Every operational inventory record gets its own UUID.
- The QuickBooks invoice ID remains the durable external reference; invoice number is stored separately.
- The order-line model is the primary commitment point rather than the invoice header.

---

## 3. Proposed sidebar and navigation change

### Preserve existing service navigation exactly as-is

### Containers implementation update

The first functional pass for the new inventory layer is now implemented in the protected app under [src/app/(protected)/containers/page.tsx](src/app/(protected)/containers/page.tsx) and [src/app/(protected)/containers/[id]/page.tsx](src/app/(protected)/containers/[id]/page.tsx).

It currently provides:

- a list of active containers from the new Supabase schema;
- a simple Add Container form for supplier, container number, products/quantities, dates, payment info, tracking, ETA, and notes;
- a detail view for each container with product lines, payment/logistics details, and notes;
- ETA handling that shows a confirmed ETA when present and otherwise shows a 75-day estimated ETA with visual distinction;
- a practical display of incoming inventory before receipt, without applying any allocation automation yet.

This remains additive and does not alter the existing Service Tracker routes or flow.

### My Sales implementation update

A first-pass My Sales visibility dashboard is now available at [src/app/(protected)/my-sales/page.tsx](src/app/(protected)/my-sales/page.tsx).

It currently provides:

- a read-only dashboard for sales-facing visibility into paid orders that have reached the shipping workflow;
- search by customer name or invoice number;
- stage filters for awaiting review, approved/waiting, ready, partial, and shipped orders;
- expandable invoice details that show line-level product status, inventory context, and queue/container context;
- role-based visibility through the existing navigation and role helper in [src/lib/roles.ts](src/lib/roles.ts).

This keeps Shipping as the operational owner of approvals, queues, and fulfillment while allowing sales users to see the current state of their customers' orders without editing operational records.

Keep the current service paths and labels:

- Dashboard
- Cases
- Create Case
- Installation
- Archived / Completed
- Settings

### Add new top-level groups without removing service functionality

A safe first version would be:

- Dashboard
- CRM / Customers
- Sales
- Shipping
- Inventory
  - Inventory Overview
  - Containers
  - Adjustments
  - Orders / Purchase Orders
  - Products / Mapping
- Service
  - Service Dashboard
  - Cases
  - Create Case
  - Installation
  - Archived / Completed
- Settings

### Implementation note

The current sidebar structure in [src/app/(protected)/sidebar-nav.tsx](src/app/(protected)/sidebar-nav.tsx) can be expanded by adding new nav groups while preserving the existing service links and their routes.

---

## 4. QBO Paid -> Shipping Review -> Approval -> Product Queue flow

1. QuickBooks invoice becomes Paid.
2. The existing QBO sync layer imports the invoice into the new operational layer as a review record.
3. Each invoice line is imported into public.qbo_invoice_lines with a default approval status of Pending Review.
4. Shipping reviews each line and maps it to an internal product via public.products + public.product_aliases.
5. If a line is approved, a shipping_order_line is created and that approved quantity contributes to sold and queue availability.
6. If a line is held or removed, it does not contribute to sold and does not receive queue positions.

### Important rule

Paid in QuickBooks does not automatically reserve inventory.

Inventory only moves into sold/queue state after explicit shipping approval.

---

## 5. Inventory equations and event/ledger rules

The inventory model should be derived from ledger transactions rather than mutable counters alone.

### Core equations

- Sold = sum of remaining approved quantity on open queue/line records.
- On Floor = sum of ledger movements in the ON_FLOOR bucket.
- Available Now = On Floor - committed quantity for approved orders that are already allocated.
- Incoming / On Order = sum of unreceived container quantities from active containers.
- Incoming Available to Sell = Incoming / On Order - committed quantity for approved orders.
- Total Future Availability = Available Now + Incoming Available to Sell.

### Ledger rules

Every inventory movement must create an inventory_transactions row.

Examples:

- Container created: ON_ORDER +18
- Container received: ON_ORDER -18, ON_FLOOR +18
- Customer order approved: SOLD +4
- Partial fulfillment: SOLD -2, ON_FLOOR -2
- Adjustment: signed delta to the relevant bucket
- Cancellation or removal: reverse prior approval or allocation

### Reconciliation model

The system should support reconciliation between:

- calculated balance from ledger;
- cached product summary values; and
- sum of active container quantities.

If they differ, the UI should flag a discrepancy rather than silently hiding it.

---

## 6. Partial fulfillment design

Partial fulfillment must be first-class behavior.

### Line-level fields

Each shipping_order_line should carry:

- ordered_qty
- approved_qty
- fulfilled_qty
- cancelled_qty
- remaining_qty

### Formula

```text
remaining_qty = approved_qty - fulfilled_qty - cancelled_qty
```

### Operational behavior

- Shipping can fulfill only part of the approved quantity.
- The remaining quantity stays in the queue.
- Fulfillment creates one or more fulfillment rows and inventory_transactions rows rather than mutating the original quantity in place.
- A line is not marked fully fulfilled unless the approved quantity has been fully consumed.

---

## 7. Duplicate-QBO-invoice handling

### Constraint

Never use the QuickBooks invoice number as the primary key.

### Approach

- Each imported invoice gets its own internal UUID.
- The QuickBooks invoice transaction ID is stored as the durable external reference.
- The visible invoice number is stored separately as a field.
- Each invoice line also gets its own UUID and can be linked to a shipping order line independently.

### Idempotency rule

Repeated syncs must not create duplicate operational rows.

Recommended pattern:

- upsert by qbo_invoice_id and qbo_line_id;
- keep an external reference column;
- use a unique constraint on the natural external identifier for import stability.

This makes duplicate invoice numbers harmless because the system uses the internal UUID plus the external QuickBooks IDs rather than the invoice number as the identity.

---

## 8. Container lifecycle

### Phase 1 container workflow

1. Container/order created
   - internal container ID
   - container or PO number
   - supplier
   - order date
   - date entered into CRM
   - products and quantities
   - deposit amount/date
   - remaining balance
   - payment status
   - production status
   - final payment status/date
   - tracking/container number
   - ETA
   - port date if known
   - notes/documents
   - status

2. Production
   - inventory remains incoming/on order and remains potentially sellable until committed by customer demand.

3. Final payment / ready to ship
   - once the final payment is recorded, the container moves to Inbound.
   - Inbound does not mean unavailable; it remains sellable unless already committed.

4. ETA
   - if no confirmed logistics data exists, the initial ETA should be estimated as 75 days from the date the container was entered.
   - the model should support both estimated and confirmed ETA/port dates.

5. Receiving
   - upon receipt, inventory is moved from ON_ORDER to ON_FLOOR through auditable ledger transactions.
   - example: ON_ORDER -18, ON_FLOOR +18

### Status distinction

The lifecycle should not overload a single status field. The safer design uses separate concepts for:

- payment status
- production status
- lifecycle status
- ETA confidence (estimated vs confirmed)

---

## 9. Permissions and RLS changes

### Phase 1 approach

To preserve the current service app, the initial rollout should keep the existing service permissions intact and add new inventory tables with authenticated access first.

### Suggested eventual role model

- Sales: read inventory availability and queues.
- Shipping/Warehouse: approve lines, change warehouse status, fulfill quantities, change priorities, and add operational notes.
- Purchasing: manage containers, purchase order data, supplier/payment/logistics information.
- Customer Service: keep existing service tracker access.
- Admin/Management: adjustments, reconciliation, mapping, and full audit visibility.

### RLS strategy

- Keep existing service-table policies as-is for the first phase.
- Add new policies for inventory tables that allow authenticated users to read/write while the workflow is being introduced.
- Tighten to role-based policies after the ledger and workflow are verified.

---

## 10. Migration plan proving the existing Service Tracker remains intact

### Step 1: backup and inspect

- Export the current Supabase schema and data.
- Capture a backup of the service tables before any new inventory tables are added.

### Step 2: add inventory tables incrementally

- Add new tables in separate migrations.
- Use create table if not exists and add policies without dropping or renaming current service tables.

### Step 3: preserve existing routes and navigation

- Keep the current URLs and service pages unchanged.
- Extend the sidebar with new inventory groups instead of replacing the service group.

### Step 4: add the new inventory shell

- Add placeholder pages for Inventory Overview, Containers, Adjustments, Shipping Queue, and Products / Mapping.
- Ensure the existing Dashboard, Cases, Create Case, Installation, Archived / Completed, and Settings pages continue to load exactly as before.

### Step 5: add QBO import behind review state

- Import QuickBooks invoices into a review state first.
- Do not allow paid invoices to create sold inventory until explicit approval occurs.

### Step 6: validate service tracker behavior

Smoke-test the existing flows after each migration:

- create a case
- open a case detail page
- create an installation job
- view archived/completed cases
- access settings

### Step 7: only then expand into full inventory writes

- Start with read-only inventory views.
- Add approval, queue, and fulfillment workflows once reconciliation and ledger rules are verified.

---

## Recommendation

The safest implementation path is a phased, additive rollout:

1. preserve the current Service Tracker exactly as it exists today;
2. add inventory/navigation shells first;
3. add product mapping and containers next;
4. implement the ledger and approval workflow after reconciliation rules are reviewed;
5. only then expand beyond inventory into broader CRM/ERP features.

This approach keeps the existing business workflow intact while creating a durable foundation for inventory, shipping, purchases, and future ERP operations.
