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
- Archived/completed case view with reopen support
- Multi-file attachment gallery with upload, download, and delete controls
- Workflow-first create-case workspace with dedicated sections for Customer Information, Issue Details, Photos/Attachments, Timeline/Notes, and Resolution/Status
- Case details timeline defaults to the 5 most recent events with a View All toggle for full history
- QuickBooks-prefilled customer/invoice card on intake with editable local shipping address (saved in app only; no QuickBooks writeback) and editable customer notes
- Create-time attachment queue previews with filename, size, selected time, selected by, and remove control before submit
- Create-time internal notes queue that is converted into case notes and case_activity timeline rows on save

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
