# Phase 2 QuickBooks Plan (Sandbox First)

## Goals

- Add OAuth connection to QuickBooks Online sandbox
- Search customers and invoices from app UI
- Link invoice records to customer service cases
- Import invoice/customer snapshot fields into quickbooks_invoices

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
6. Add background sync job for refreshed invoice data if needed.

## Test Plan

- OAuth success and deny paths
- Token refresh path
- Search results accuracy in sandbox
- Link/unlink invoice behavior
- Verify no writes are sent to QuickBooks
