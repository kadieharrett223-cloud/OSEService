# Phase 2 QuickBooks Plan (Sandbox First)

## Goals

- Add OAuth connection to QuickBooks Online sandbox
- Extend current snapshot lookup to direct live QuickBooks search from app UI
- Link invoice records to customer service cases
- Import invoice/customer snapshot fields into quickbooks_invoices

## Current Baseline

- Create-case now supports lookup autofill by customer/invoice from stored `customers` and `quickbooks_invoices` records.
- Lookup includes typeahead suggestions while typing via `/api/quickbooks/suggestions`.
- Autofill now carries fuller snapshot details (invoice date, total, payment status, billing/shipping address) into intake review fields.
- Autofill now includes invoice product lines (parsed from `quickbooks_invoices.raw_payload`) and a direct "View Full Invoice" link for intake visibility.
- Create-case customer card now treats QuickBooks customer/invoice data as read-only to reduce duplicate data entry.
- Intake defaults to unassigned case creation and captures an explicit enter date for reporting timestamp fallback.
- Protected app header now surfaces QuickBooks status as connected/disconnected using snapshot availability, with a Connect action when disconnected.
- Settings now includes live QuickBooks OAuth connect, disconnect, and manual invoice sync.
- OAuth callback performs first sync to populate `quickbooks_invoices` and `customers` snapshots.
- Create-case now auto-sets issue reported timestamp at save time and auto-populates date of purchase from matched invoice date.

## Constraints

- Read-only integration for first release
- No invoice edits from app
- No accounting write operations

## Implementation Outline

1. Add /api/integrations/quickbooks/connect route.
2. Add /api/integrations/quickbooks/callback route.
3. Persist encrypted token material in quickbooks_connections (new table).
4. Build "Find Invoice" UI in create case workflow.
5. Store quickbooks_customer_id and quickbooks_invoice_id on case linkage.
6. Add manual sync from settings (implemented).
7. Add background sync job for refreshed invoice data if needed.

## Test Plan

- OAuth success and deny paths
- Token refresh path
- Search results accuracy in sandbox
- Link/unlink invoice behavior
- Verify no writes are sent to QuickBooks
