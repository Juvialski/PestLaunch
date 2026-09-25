create table public.call_notifications (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  notification_type text not null check (notification_type = 'HIGH_RISK_ALERT'),
  recipient text not null check (
    recipient = lower(btrim(recipient))
    and char_length(recipient) between 3 and 320
  ),
  provider text not null check (provider = 'BREVO'),
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED')),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 500),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  error_message text check (error_message is null or char_length(error_message) <= 1000),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint call_notifications_status_sent_at_check
    check ((status = 'SENT') = (sent_at is not null)),
  constraint call_notifications_call_type_recipient_key
    unique (call_id, notification_type, recipient)
);

alter table public.call_notifications enable row level security;

revoke all on table public.call_notifications from public, anon, authenticated;
grant select, insert, update on table public.call_notifications to service_role;
