# Olympic Equipment Customer Service Tracking App

Simple internal web app for customer service case tracking.

## Tech Stack

- Next.js (App Router, TypeScript)
- Supabase (Postgres, Storage)
- Vercel (deployment)
- GitHub (source control + Vercel integration)

## Phase 1 Features

- Access-code entry gate (no Supabase user login required)
- One shared access code with per-person login history tracking
- Create and view customer service cases
- Search and filter case list
- Status and priority updates
- Internal and customer-facing notes
- Replacement part tracking
- Attachment uploads (private storage)
- Activity timeline with persistent history

## Project Structure

- `src/app/login`: legacy redirect to access-code page
- `src/app/enter-code`: access-code entry UI
- `src/app/(protected)`: dashboard and case workflows
- `src/lib/supabase`: client/server Supabase helpers
- `supabase/migrations`: SQL schema and RLS policies
- `docs`: architecture, rollback, and phase plans

## Environment Files

1. Copy `.env.local.example` to `.env.local`
2. Fill in Supabase URL, anon key, service role key, app session secret, and shared access code
3. Keep QuickBooks values empty or sandbox-only until Phase 2

## Local Setup

1. Install dependencies
	`npm install`
2. Run app
	`npm run dev`
3. Open http://localhost:3000

## Supabase Setup

1. Create a Supabase project.
2. Run migration in SQL editor:
	`supabase/migrations/202607300001_phase1_customer_service.sql`
3. Run follow-up migration for access-code auth:
	`supabase/migrations/202607300002_access_code_auth.sql`
4. Confirm bucket `case-attachments` exists.
5. In `/settings`, create at least one access user.

## Vercel Deployment

1. Push repository to GitHub.
2. Import repo in Vercel.
3. Set production environment variables from `.env.production.example`.
4. Deploy and run smoke tests.

## Security Notes

- Never expose Supabase service role in client code.
- Keep QuickBooks credentials only in server environment variables.
- Use QuickBooks sandbox for integration development.
- Access checks are server-side via signed session cookie and access code.

## Backup and Rollback

See `docs/backup-and-rollback.md` for database, storage, deployment rollback, and migration recovery guidance.

## Suggested First Setup Steps

1. Set `APP_SHARED_ACCESS_CODE` in your environment.
2. Create at least one access user in `/settings`.
3. Enter shared code and create first case.
4. Add additional internal users for assignment and audit history.
