# Backup and Rollback Process

## Database Backup

1. In Supabase Dashboard, open Project Settings -> Database.
2. Use managed backups and verify backup retention.
3. Before major schema changes, create an on-demand backup.
4. Export a schema snapshot for release records.

## Storage Backup

1. The app stores files in bucket case-attachments.
2. Before major releases, export bucket objects and metadata.
3. Keep backup copy in secured internal storage.

## Application Rollback

1. Vercel keeps prior deployments.
2. If a release is unstable, redeploy previous successful build.
3. Re-run smoke tests for login, case list, and case detail pages.

## Migration Rollback

1. Use a forward-fix migration as primary rollback strategy.
2. Avoid deleting production data in rollback SQL unless fully approved.
3. If rollback SQL is required, include:
   - impact summary
   - affected tables/columns
   - data recovery plan

## QuickBooks Safety

1. Keep QUICKBOOKS_ENV=sandbox until all workflows are validated.
2. Never run first-time OAuth tests against live company data.
3. Verify imported invoice fields in sandbox before production cutover.
