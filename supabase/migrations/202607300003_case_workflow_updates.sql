-- Phase 1C: Case workflow enhancements
-- Adds case type segmentation and explicit in-progress/completed statuses.

alter table public.customer_service_cases
  add column if not exists case_type text not null default 'General';

update public.customer_service_cases
set case_type = 'General'
where case_type is null;

alter table public.customer_service_cases
  drop constraint if exists customer_service_cases_case_type_check;

alter table public.customer_service_cases
  add constraint customer_service_cases_case_type_check
  check (case_type in ('General', 'Warranty', 'Freight Damage'));

alter table public.customer_service_cases
  drop constraint if exists customer_service_cases_status_check;

alter table public.customer_service_cases
  add constraint customer_service_cases_status_check
  check (
    status in (
      'New',
      'In Progress',
      'Waiting for Customer',
      'Under Review',
      'Parts Needed',
      'Parts Ordered',
      'Parts Shipped',
      'Service Scheduled',
      'Completed',
      'Resolved',
      'Closed'
    )
  );

create index if not exists idx_cases_case_type on public.customer_service_cases(case_type);
