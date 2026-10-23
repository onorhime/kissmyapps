-- Transactional agreement emails. Platform triggers call the
-- agreement-notify Edge Function through pg_net whenever an agreement
-- document reaches a signing milestone. The Edge Function loads the full
-- context itself; triggers only carry the document identifier and event.
--
-- Events:
--   documents INSERT (awaiting_partner_signature)      -> partner signing request
--   documents UPDATE -> awaiting_kissmyapps_signature  -> KissMyApps admins
--   documents UPDATE -> signed                         -> partner confirmation

create extension if not exists pg_net with schema extensions;

create schema if not exists kma_internal;
revoke all on schema kma_internal from public, anon, authenticated, service_role;

create table if not exists kma_internal.function_secrets (
  name text primary key,
  value text not null
);
revoke all on kma_internal.function_secrets
  from public, anon, authenticated, service_role;

-- Provision the notification credential through the deployment secret store.
-- Never put a live credential in migration source or its history.

create or replace function public.notify_agreement_document_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_type text;
  secret_value text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'awaiting_partner_signature' then
      event_type := 'signing_request';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'awaiting_kissmyapps_signature'
       and old.status = 'awaiting_partner_signature' then
      event_type := 'partner_signed';
    elsif new.status = 'signed'
       and old.status = 'awaiting_kissmyapps_signature' then
      event_type := 'agreement_fully_signed';
    end if;
  end if;

  if event_type is null then
    return coalesce(new, old);
  end if;

  select value into secret_value
  from kma_internal.function_secrets
  where name = 'agreement_notify';

  perform extensions.http_post(
    'https://mmyruzjemjecqyivhrgr.supabase.co/functions/v1/agreement-notify',
    jsonb_build_object('type', event_type, 'document_id', new.id)::text,
    'application/json',
    jsonb_build_object('x-kma-internal-secret', secret_value)
  );

  return coalesce(new, old);
end;
$$;

revoke all on function public.notify_agreement_document_event()
  from public, anon, authenticated, service_role;

drop trigger if exists agreement_documents_email on public.documents;
create trigger agreement_documents_email
  after insert or update of status on public.documents
  for each row
  execute function public.notify_agreement_document_event();

comment on function public.notify_agreement_document_event() is
  'Fires the agreement-notify Edge Function for signing milestones: partner signing request, partner signature received, and countersigned. Best-effort delivery through pg_net; notification failures never block the database mutation.';
