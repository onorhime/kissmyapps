begin;

-- A merchant forwards a permitted network report and the original SDK first-launch
-- identifiers it attached to that report. Existing attributed installs keep their source.
alter table public.attribution_installs drop constraint attribution_installs_method_check,
  add constraint attribution_installs_method_check check(method in ('link_open','install_referrer','apple_ads','clipboard','login','organic','reinstall','network_report'));
alter table public.analytics_people drop constraint analytics_people_acquisition_method_check,
  add constraint analytics_people_acquisition_method_check check(acquisition_method in ('link_open','install_referrer','apple_ads','clipboard','login','organic','reinstall','network_report'));
create table kma_internal.network_install_receipts (
  project_id uuid not null references public.analytics_projects on delete cascade,
  environment text not null,
  network text not null check(network in ('meta','tiktok')),
  receipt_hash bytea not null,
  fingerprint bytea not null,
  install_id uuid not null references public.attribution_installs on delete cascade,
  outcome text not null check(outcome in ('matched','existing_attribution')),
  primary key(project_id,environment,network,receipt_hash)
);
revoke all on kma_internal.network_install_receipts from public,anon,authenticated,service_role;
create function public.network_install_record(p_key_hash text,p_report jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare
  k public.analytics_api_keys;
  i public.attribution_installs;
  prior kma_internal.network_install_receipts;
  network_name text:=p_report->>'network';
  hash bytea:=extensions.digest(p_report->>'report_id','sha256');
  signature bytea:=extensions.digest(p_report::text,'sha256');
  outcome text;
begin
  select keys.* into k from public.analytics_api_keys keys join public.attribution_settings s on s.project_id=keys.project_id
    where keys.token_hash=decode(p_key_hash,'hex') and keys.kind='server' and keys.revoked_at is null and s.enabled;
  if k.id is null then raise exception 'Project is unavailable' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(k.project_id::text||k.environment||network_name||encode(hash,'hex'),0));
  select * into prior from kma_internal.network_install_receipts n where n.project_id=k.project_id and n.environment=k.environment and n.network=network_name and n.receipt_hash=hash;
  if prior.install_id is not null then
    return case when prior.fingerprint=signature then prior.outcome else 'conflicting_receipt' end;
  end if;
  begin
    select inst.* into strict i from public.attribution_installs inst join public.analytics_people person on person.id=inst.person_id
    where inst.project_id=k.project_id and inst.environment=k.environment and inst.platform=p_report->>'platform'
    and inst.session_key=p_report->>'session_id' and person.anonymous_ids @> array[p_report->>'anonymous_id']
    order by inst.id for update of inst;
  exception when no_data_found then return 'awaiting_install';
    when too_many_rows then return 'ambiguous_install';
  end;
  if i.method='organic' and i.verdict='counted' then
    update public.attribution_installs set method='network_report',exact=true,source=network_name,channel='paid',campaign=p_report->>'campaign' where id=i.id;
    update public.analytics_people set acquisition_method='network_report',acquisition_source=network_name,acquisition_campaign=p_report->>'campaign'
      where id=i.person_id and (acquisition_method is null or acquisition_method='organic');
    outcome:='matched';
  else outcome:='existing_attribution'; end if;
  insert into kma_internal.network_install_receipts values(k.project_id,k.environment,network_name,hash,signature,i.id,outcome);
  return outcome;
end $$;
revoke all on function public.network_install_record(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.network_install_record(text,jsonb) to service_role;

commit;
