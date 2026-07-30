# Phase 1 Architecture

## Scope
Phase 1 implements only internal customer service case tracking:

- Employee login
- Access-code login
- Shared code with per-person login history
- Customer/case creation
- Case type routing (General, Warranty, Freight Damage)
- Status and priority updates
- Workflow shortcuts for In Progress, Completed, and Reopen
- Internal/customer notes
- Attachment upload metadata and secure storage
- Replacement part tracking
- Immutable activity timeline entries
- Workflow action buttons that append timeline events (customer contacted, waiting states, warranty/parts/tracking updates)
- Search and filtering for operations
- Archived/completed case view with reopen support
- Multi-file attachment gallery with upload, download, and delete controls

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
