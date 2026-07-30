# Release Checklist

## Pre-Deploy

- [ ] Migration applied successfully in target environment
- [ ] Access code entry works for active users
- [ ] Login history entries are written in access_login_events
- [ ] Attachment upload and download tested
- [ ] Search and case filters tested
- [ ] Dashboard metrics render correctly
- [ ] No QuickBooks production credentials configured

## Deploy

- [ ] Vercel environment variables configured
- [ ] Deployment completes without runtime errors
- [ ] Smoke test completed after deploy

## Post-Deploy

- [ ] Confirm activity history writes for create/update/note/upload/part events
- [ ] Confirm invalid/disabled codes cannot open protected routes
- [ ] Confirm rollback target deployment noted in release log
