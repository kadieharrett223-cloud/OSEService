# Installation Workflow

The Installation workflow provides a dedicated space for installers to record new jobs, attach photos, and keep a shared log of progress.

## What it includes

- Protected route: /installation
- New submission form: /installation/new
- Job detail view: /installation/[id]
- Shared storage for photos using the existing case-attachments bucket
- Installer-specific tables:
  - installation_jobs
  - installation_notes
  - installation_photos

## Database setup

Apply the migration:

- supabase/migrations/202608030001_installation_workflow.sql

## Notes

This workflow is intentionally separate from customer service cases so installers can focus on installation progress without changing the existing case flow.
