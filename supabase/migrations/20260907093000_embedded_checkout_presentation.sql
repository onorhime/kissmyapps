begin;
-- No buyer email or Stripe client secret is stored in the attribution DB.
-- Keyed fingerprints prevent retries from changing presentation or buyer input.
create table kma_internal.checkout_presentations (
  attempt_id uuid primary key references public.checkout_attempts(id),
  ui_mode text not null check(ui_mode in ('hosted','embedded')),
  request_fingerprint text not null check(request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
alter table kma_internal.checkout_presentations enable row level security;
revoke all on kma_internal.checkout_presentations from public,anon,authenticated,service_role;

create function public.bind_checkout_presentation(p_attempt_id uuid,p_ui_mode text,p_fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ca public.checkout_attempts%rowtype; saved kma_internal.checkout_presentations%rowtype;
begin
  if p_ui_mode not in ('hosted','embedded') or p_ui_mode is null or
    p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid presentation' using errcode='22023';
  end if;
  select * into ca from public.checkout_attempts where id=p_attempt_id for update;
  if ca.id is null or ca.status not in ('prepared','open') then raise exception 'Attempt unavailable' using errcode='P0002'; end if;
  select * into saved from kma_internal.checkout_presentations where attempt_id=ca.id;
  if saved.attempt_id is null then
    -- Legacy open sessions must not acquire a different request fingerprint.
    if ca.status<>'prepared' then raise exception 'Legacy checkout already opened' using errcode='23514'; end if;
    insert into kma_internal.checkout_presentations values(ca.id,p_ui_mode,p_fingerprint,now());
  elsif saved.ui_mode<>p_ui_mode or saved.request_fingerprint<>p_fingerprint then
    raise exception 'Checkout retry input changed' using errcode='23505';
  end if;
  return jsonb_build_object('session_id',ca.stripe_checkout_session_id);
end $$;
revoke all on function public.bind_checkout_presentation(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.bind_checkout_presentation(uuid,text,text) to service_role;

-- Embedded Checkout has a client secret, never a hosted redirect URL.
do $$ declare c record; found_count int:=0;
begin
 for c in select conname,pg_get_constraintdef(oid) def from pg_constraint
   where conrelid='public.checkout_attempts'::regclass and contype='c' loop
   if c.def like '%status%' and c.def like '%checkout_url IS NOT NULL%' then
     found_count:=found_count+1;
     execute format('alter table public.checkout_attempts drop constraint %I',c.conname);
     execute format('alter table public.checkout_attempts add constraint %I %s',c.conname,
       replace(c.def,' AND (checkout_url IS NOT NULL)',''));
   end if;
 end loop;
 if found_count<>1 then raise exception 'Checkout constraint source drift'; end if;
end $$;

create function kma_internal.check_checkout_presentation_url()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status in ('open','completed','expired') and
   ((new.checkout_url is null) is distinct from exists(select 1 from kma_internal.checkout_presentations
      where attempt_id=new.id and ui_mode='embedded')) then
   raise exception 'Checkout URL conflicts with immutable presentation' using errcode='23514';
 end if;
 return new;
end $$;
revoke all on function kma_internal.check_checkout_presentation_url() from public,anon,authenticated,service_role;
create trigger checkout_presentation_url before insert or update on public.checkout_attempts
  for each row execute function kma_internal.check_checkout_presentation_url();

do $patch$
declare body text; before text;
begin
 body:=pg_get_functiondef('public.finalize_checkout_attempt(jsonb)'::regprocedure);
 before:='or jsonb_typeof(p_input -> ''checkout_url'') <> ''string''';
 if strpos(body,before)=0 then raise exception 'Finalizer source drift'; end if;
 body:=replace(body,before,'or (jsonb_typeof(p_input -> ''checkout_url'') is distinct from ''string'' and not (
   p_input -> ''checkout_url'' = ''null''::jsonb and exists(select 1 from kma_internal.checkout_presentations cp
     where cp.attempt_id=attempt_id_value and cp.ui_mode=''embedded'')))');
 -- Null only passes the SQL URL predicate for the explicitly bound embedded mode.
 execute body;
 body:=pg_get_functiondef('public.get_funnel_checkout_context(jsonb,uuid,uuid)'::regprocedure);
 before:='return jsonb_build_object(''status'',case when attempt_record.status=';
 if strpos(body,before)=0 then raise exception 'Receipt context source drift'; end if;
 body:=replace(body,before,'return jsonb_build_object(''verification'',jsonb_build_object(
   ''session_id'',attempt_record.stripe_checkout_session_id,''attempt_id'',attempt_record.id,
   ''public_attempt_id'',attempt_record.public_attempt_id,''offer_id'',attempt_record.billing_offer_id,
   ''product_id'',attempt_record.product_id,''acquisition_id'',attempt_record.acquisition_id,
   ''click_id'',attempt_record.click_record_id,''currency'',attempt_record.currency,
   ''amount_minor'',attempt_record.unit_amount_minor,''mode'',attempt_record.billing_mode),
   ''status'',case when attempt_record.status=');
 execute body;
end $patch$;
commit;
