begin;

-- Aggregate Apple postbacks have no customer, installation or commission identity.
create table kma_internal.skan_receipts (
  project_id uuid not null references public.analytics_projects on delete cascade,
  environment text not null check(environment in ('development','production')),
  transaction_id uuid not null,
  network text not null,
  source_id text not null,
  sequence smallint not null check(sequence between 0 and 2),
  redownload boolean not null,
  received_at timestamptz not null default now(),
  primary key(project_id,environment,transaction_id)
);
create index skan_receipts_report on kma_internal.skan_receipts(project_id,environment,received_at desc);
revoke all on kma_internal.skan_receipts from public,anon,authenticated,service_role;

create function public.skan_record_postback(p_key_hash text,p_postback jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare k public.analytics_api_keys;
begin
  select keys.* into k from public.analytics_api_keys keys join public.attribution_settings s on s.project_id=keys.project_id
    where keys.token_hash=decode(p_key_hash,'hex') and keys.kind='server' and keys.revoked_at is null
    and s.enabled and s.ios_app_store_id=p_postback->>'app_id';
  if k.id is null then raise exception 'Project or app mismatch' using errcode='42501'; end if;
  if (p_postback->>'won')::boolean is not true then return 'non_winning'; end if;
  insert into kma_internal.skan_receipts(project_id,environment,transaction_id,network,source_id,sequence,redownload)
    values(k.project_id,k.environment,(p_postback->>'transaction')::uuid,p_postback->>'network',p_postback->>'source',
      (p_postback->>'sequence')::smallint,(p_postback->>'redownload')::boolean) on conflict do nothing;
  if found then return 'recorded'; end if;
  return 'duplicate';
end $$;

create function public.attribution_skan_report(p_project uuid,p_environment text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare pr public.analytics_projects:=kma_internal.analytics_require_project(p_project);
begin
 if coalesce(p_environment,'') not in ('development','production') then raise exception 'Choose a report environment' using errcode='22023'; end if;
 return (with report as (
   select network, count(*) filter(where sequence=0 and not redownload) installs,
     count(*) filter(where sequence=0 and redownload) redownloads,count(*) filter(where sequence>0) followups,max(received_at) last_received
   from kma_internal.skan_receipts where project_id=pr.id and environment=p_environment and received_at>=now()-interval '30 days' group by network)
   select coalesce(jsonb_agg(to_jsonb(r) order by installs desc,network),'[]'::jsonb) from report r);
end $$;
revoke all on function public.skan_record_postback(text,jsonb),public.attribution_skan_report(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.skan_record_postback(text,jsonb) to service_role;
grant execute on function public.attribution_skan_report(uuid,text) to authenticated;

commit;
