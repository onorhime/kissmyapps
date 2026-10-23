-- Readable aliases are an additional, immutable address for each existing link.
-- Never rewrite a public_code, legacy tracking_url, or attribution dimension.
begin;

create table kma_internal.creator_tracking_handles (
 affiliate_id uuid unique references public.affiliates(id) on delete set null,
 handle text primary key check(length(handle) between 1 and 64 and handle ~ '^[[:alnum:]]+(-[[:alnum:]]+)*$')
);
create table kma_internal.product_tracking_handles (
 product_id uuid unique references public.products(id) on delete set null,
 handle text primary key check(length(handle) between 1 and 64 and handle ~ '^[[:alnum:]]+(-[[:alnum:]]+)*$' and handle not in ('r','tracking-redirect'))
);
create table kma_internal.tracking_link_aliases (
 link_id uuid unique references public.affiliate_links(id) on delete set null,
 path text primary key check(length(path) <= 180 and path ~ '^/[[:alnum:]]+(-[[:alnum:]]+)*/[[:alnum:]]+(-[[:alnum:]]+)*(/[[:alnum:]]+(-[[:alnum:]]+)*)?$'),
 created_at timestamptz not null default now()
);
revoke all on kma_internal.creator_tracking_handles,kma_internal.product_tracking_handles,kma_internal.tracking_link_aliases from public,anon,authenticated,service_role;

create function kma_internal.readable_handle(p_text text,p_fallback text,p_max integer)
returns text language sql immutable set search_path='' as $$
 select coalesce(nullif(trim(both '-' from left(regexp_replace(normalize(lower(normalize(coalesce(p_text,''),NFC)),NFC),
   '[^[:alnum:]]+','-','g'),p_max)),''),p_fallback);
$$;

create function kma_internal.ensure_tracking_link_alias(p_link_id uuid)
returns text language plpgsql volatile security definer set search_path='' as $$
declare
 link public.affiliate_links; creator public.affiliates; product public.products;
 creator_handle text; product_handle text; base text; candidate text; suffix integer;
 variant text; alias_path text;
begin
 select path into alias_path from kma_internal.tracking_link_aliases where link_id=p_link_id;
 if alias_path is not null then return 'https://go.kissmyapps.dev'||alias_path;end if;
 -- Issuance is rare; one transaction lock serializes readable namespace claims.
 -- Unique constraints are the final guard, including simultaneous name collisions.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('readable-tracking-alias-allocation',0));
 select path into alias_path from kma_internal.tracking_link_aliases where link_id=p_link_id;
 if alias_path is not null then return 'https://go.kissmyapps.dev'||alias_path;end if;
 select * into link from public.affiliate_links where id=p_link_id;
 if link.id is null then raise exception 'link unavailable' using errcode='P0002';end if;
 select * into creator from public.affiliates where id=link.affiliate_id;
 select * into product from public.products where id=link.product_id;
 select handle into creator_handle from kma_internal.creator_tracking_handles where affiliate_id=creator.id;
 if creator_handle is null then
  base:=kma_internal.readable_handle(case when creator.slug ~ '^partner-[0-9a-f]{24}$' then creator.public_name else creator.slug end,'creator',48);
  candidate:=base;suffix:=1;
  while exists(select 1 from kma_internal.creator_tracking_handles where handle=candidate) loop
   suffix:=suffix+1;if suffix>100000 then raise exception 'creator handle namespace exhausted' using errcode='54000';end if;
   candidate:=base||'-'||suffix;
  end loop;
  insert into kma_internal.creator_tracking_handles values(creator.id,candidate);creator_handle:=candidate;
 end if;
 select handle into product_handle from kma_internal.product_tracking_handles where product_id=product.id;
 if product_handle is null then
  base:=kma_internal.readable_handle(product.slug,'product',48);
  if base in ('r','tracking-redirect') then base:=base||'-product';end if;
  candidate:=base;suffix:=1;
  while exists(select 1 from kma_internal.product_tracking_handles where handle=candidate) loop
   suffix:=suffix+1;if suffix>100000 then raise exception 'product handle namespace exhausted' using errcode='54000';end if;
   candidate:=base||'-'||suffix;
  end loop;
  insert into kma_internal.product_tracking_handles values(product.id,candidate);product_handle:=candidate;
 end if;
 base:='/'||product_handle||'/'||creator_handle;
 if link.is_main then
  alias_path:=base;suffix:=1;
  while exists(select 1 from kma_internal.tracking_link_aliases where path=alias_path) loop
   suffix:=suffix+1;if suffix>100000 then raise exception 'link alias namespace exhausted' using errcode='54000';end if;
   alias_path:=base||'/'||suffix;
  end loop;
 else
  variant:=kma_internal.readable_handle(link.name,'link',40);
  alias_path:=base||'/'||variant;suffix:=1;
  while exists(select 1 from kma_internal.tracking_link_aliases where path=alias_path) loop
   suffix:=suffix+1;if suffix>100000 then raise exception 'link alias namespace exhausted' using errcode='54000';end if;
   alias_path:=base||'/'||variant||'-'||suffix;
  end loop;
 end if;
 insert into kma_internal.tracking_link_aliases(link_id,path) values(link.id,alias_path);
 return 'https://go.kissmyapps.dev'||alias_path;
end;
$$;
create function kma_internal.tracking_link_short_url(p_link_id uuid)
returns text language sql stable set search_path='' as $$
 select 'https://go.kissmyapps.dev'||path from kma_internal.tracking_link_aliases where link_id=p_link_id;
$$;
create function kma_internal.protect_tracking_alias_identity()
returns trigger language plpgsql set search_path='' as $$
declare old_row jsonb:=to_jsonb(old);new_row jsonb:=to_jsonb(new);identity_key text;
begin
 identity_key:=case tg_table_name when 'creator_tracking_handles' then 'affiliate_id'
  when 'product_tracking_handles' then 'product_id' else 'link_id' end;
 -- Only a foreign-key deletion may retire the target. The address remains a
 -- tombstone and can never be assigned to another creator, product or link.
 if old_row->>identity_key is not null and new_row->>identity_key is null
  and (old_row-identity_key)=(new_row-identity_key) then
  if (identity_key='affiliate_id' and not exists(select 1 from public.affiliates where id=(old_row->>identity_key)::uuid))
   or (identity_key='product_id' and not exists(select 1 from public.products where id=(old_row->>identity_key)::uuid))
   or (identity_key='link_id' and not exists(select 1 from public.affiliate_links where id=(old_row->>identity_key)::uuid)) then return new;end if;
 end if;
 raise exception 'issued readable tracking handles and aliases are immutable' using errcode='P0001';
end;$$;
create trigger creator_tracking_handle_immutable before update on kma_internal.creator_tracking_handles for each row execute function kma_internal.protect_tracking_alias_identity();
create trigger product_tracking_handle_immutable before update on kma_internal.product_tracking_handles for each row execute function kma_internal.protect_tracking_alias_identity();
create trigger tracking_link_alias_immutable before update on kma_internal.tracking_link_aliases for each row execute function kma_internal.protect_tracking_alias_identity();

create function public.allocate_tracking_link_alias()
returns trigger language plpgsql security definer set search_path='' as $$begin
 perform kma_internal.ensure_tracking_link_alias(new.id);return new;
end;$$;
revoke all on function public.allocate_tracking_link_alias() from public,anon,authenticated,service_role;
create trigger affiliate_links_allocate_alias after insert on public.affiliate_links for each row execute function public.allocate_tracking_link_alias();

-- Handle/path tombstones also survive an authorized prelaunch deletion.
-- Backfill only additional addresses. Old URLs, links and all historical facts
-- remain byte-for-byte unchanged. Archived addresses stay reserved to their link.
do $$declare item record;begin
 for item in select id from public.affiliate_links order by created_at,id loop
  perform kma_internal.ensure_tracking_link_alias(item.id);
 end loop;
end;$$;

create function public.register_short_tracking_click(p_path text,p_context jsonb)
returns table(click_id text,destination_url text,is_bot boolean)
language plpgsql volatile security definer set search_path='' as $$
declare identity record;
begin
 if p_path is null or length(p_path)>180 or p_path !~ '^/[[:alnum:]]+(-[[:alnum:]]+)*/[[:alnum:]]+(-[[:alnum:]]+)*(/[[:alnum:]]+(-[[:alnum:]]+)*)?$' then
  raise exception 'tracking alias unavailable' using errcode='P0002';end if;
 select affiliate.slug,link.public_code into identity
 from kma_internal.tracking_link_aliases as alias
 join public.affiliate_links as link on link.id=alias.link_id
 join public.affiliates as affiliate on affiliate.id=link.affiliate_id
 where alias.path=p_path;
 if not found then raise exception 'tracking alias unavailable' using errcode='P0002';end if;
 -- The existing implementation owns every status, commercial, scope, rate-limit,
 -- bot and attribution check; readable paths are not a second tracking system.
 return query select * from public.register_tracking_click(identity.slug,identity.public_code,p_context);
end;$$;
revoke all on function public.register_short_tracking_click(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.register_short_tracking_click(text,jsonb) to service_role;

-- Project only URLs already owned by this signed-in partner; no public lookup
-- or base-table read permission is added for handles or alias records.
create function public.partner_link_short_url(p_link_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$begin
 if auth.uid() is null or not exists(select 1 from public.affiliate_links as link
  where link.id=p_link_id and public.current_user_has_affiliate(link.affiliate_id)) then return null;end if;
 return kma_internal.tracking_link_short_url(p_link_id);
end;$$;
revoke all on function public.partner_link_short_url(uuid) from public,anon,authenticated,service_role;
grant execute on function public.partner_link_short_url(uuid) to authenticated;

-- Append columns in place: preserve view OIDs and the composite return type
-- used by create_partner_link, update_partner_link and set_partner_link_status.
create or replace view public.partner_link_directory
with (security_barrier = true)
as
select
  link.id,
  link.name,
  link.product_id,
  product.name as product_name,
  product.slug as product_slug,
  link.funnel_id,
  funnel.name as funnel_name,
  link.source_id,
  source.name as source_name,
  link.campaign_id,
  campaign.name as campaign_name,
  link.sub1,
  coalesce(link.sub2, '') as sub2,
  coalesce(link.sub3, '') as sub3,
  link.status,
  link.tracking_url,
  link.parent_link_id,
  metric.clicks,
  case when link.commercial_eligible then metric.leads else null end as leads,
  metric.installs,
  case when link.commercial_eligible then metric.purchases else null end as purchases,
  case when link.commercial_eligible then metric.earnings_minor else null end as earnings_minor,
  case when link.commercial_eligible then agreement.payout_currency else null end as currency,
  link.created_at,
  product.tracking_mode,
  link.commercial_eligible,
  public.partner_link_short_url(link.id) as short_url
from public.affiliate_links as link
join public.affiliates as affiliate on affiliate.id = link.affiliate_id
join public.products as product on product.id = link.product_id
join public.funnels as funnel on funnel.id = link.funnel_id
left join public.sources as source on source.id = link.source_id
left join public.campaigns as campaign on campaign.id = link.campaign_id
left join lateral (
  select candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = link.affiliate_id
    and candidate.product_id = link.product_id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join lateral (
  select
    (select count(*)::bigint from public.clicks as click
      where click.affiliate_link_id = link.id) as clicks,
    (
      select count(*)::bigint
      from public.conversions as conversion
      join public.commission_rules as rule
        on rule.id = conversion.commission_rule_id and rule.model = 'cpl'
      join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id and conversion.qualified
    ) as leads,
    (
      select case when count(*) = 0 then null else count(*)::bigint end
      from public.acquisitions as acquisition
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
        and acquisition.attribution_method = 'singular'
    ) as installs,
    (
      select count(*)::bigint
      from public.transactions as transaction
      join public.acquisitions as acquisition on acquisition.id = transaction.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
    ) as purchases,
    (
      select coalesce(sum(entry.amount_minor), 0)::bigint
      from public.commission_entries as entry
      join public.conversions as conversion on conversion.id = entry.conversion_id
      join public.acquisitions as acquisition on acquisition.id = conversion.acquisition_id
      join public.clicks as click on click.id = acquisition.click_record_id
      where click.affiliate_link_id = link.id
        and entry.entry_type = 'commission'
        and agreement.payout_currency is not null
        and entry.currency = agreement.payout_currency
    ) as earnings_minor
) as metric on true
where public.current_user_has_affiliate(link.affiliate_id)
  and not link.is_main;

create or replace view public.partner_product_directory
with (security_barrier = true)
as
select distinct
  product.id,
  product.slug,
  product.name,
  product.status,
  case when product.tracking_mode = 'commercial' then agreement.status else null end
    as agreement_status,
  case when product.tracking_mode = 'commercial' then agreement.model else null end
    as commercial_model,
  case when product.tracking_mode = 'commercial' then agreement.payout_currency else null end
    as payout_currency,
  exists (
    select 1
    from public.funnels as live_funnel
    where live_funnel.product_id = product.id and live_funnel.status = 'live'
  ) as has_live_funnel,
  case
    when affiliate.status = 'active'
      and product.status = 'active'
      and coalesce(setting.tracking_enabled, false)
      and setting.tracking_base_url = 'https://go.kissmyapps.dev'
      and main_link.tracking_url is not null
      and (
        (
          product.tracking_mode = 'commercial'
          and main_link.commercial_eligible
          and agreement.id is not null
          and public.partner_agreement_is_launch_ready(agreement.id)
        )
        or (
          product.tracking_mode = 'tracking_only'
          and not main_link.commercial_eligible
          and public.partner_tracking_only_product_is_ready(product.id)
          and main_link.funnel_id = product.tracking_only_funnel_id
        )
      )
    then main_link.tracking_url
    else null
  end as main_tracking_url,
  product.tracking_mode,
  public.partner_tracking_only_product_is_ready(product.id) as tracking_only_ready,
  main_link.commercial_eligible as main_link_commercial_eligible,
  main_link.id as main_link_id,
  case
    when affiliate.status = 'active'
      and product.status = 'active'
      and coalesce(setting.tracking_enabled, false)
      and setting.tracking_base_url = 'https://go.kissmyapps.dev'
      and main_link.tracking_url is not null
      and (
        (
          product.tracking_mode = 'commercial'
          and main_link.commercial_eligible
          and agreement.id is not null
          and public.partner_agreement_is_launch_ready(agreement.id)
        )
        or (
          product.tracking_mode = 'tracking_only'
          and not main_link.commercial_eligible
          and public.partner_tracking_only_product_is_ready(product.id)
          and main_link.funnel_id = product.tracking_only_funnel_id
        )
      )
    then public.partner_link_short_url(main_link.id)
    else null
  end as main_short_url
from public.affiliate_users as membership
join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
join public.products as product on (
  exists (
    select 1 from public.agreements as related_agreement
    where related_agreement.affiliate_id = membership.affiliate_id
      and related_agreement.product_id = product.id
  )
  or exists (
    select 1 from public.affiliate_links as related_link
    where related_link.affiliate_id = membership.affiliate_id
      and related_link.product_id = product.id
  )
  or exists (
    select 1 from public.payouts as related_payout
    where related_payout.affiliate_id = membership.affiliate_id
      and related_payout.product_id = product.id
  )
  or exists (
    select 1 from public.affiliate_daily_metrics as related_metric
    where related_metric.affiliate_id = membership.affiliate_id
      and related_metric.product_id = product.id
  )
)
left join lateral (
  select candidate.id, candidate.status, candidate.model, candidate.payout_currency
  from public.agreements as candidate
  where candidate.affiliate_id = membership.affiliate_id
    and candidate.product_id = product.id
  order by (candidate.status = 'active') desc, candidate.version desc
  limit 1
) as agreement on true
left join lateral (
  select link.id, link.tracking_url, link.funnel_id, link.commercial_eligible
  from public.affiliate_links as link
  join public.funnels as funnel
    on funnel.id = link.funnel_id
   and funnel.product_id = link.product_id
   and funnel.is_default
   and funnel.status = 'live'
  where link.affiliate_id = membership.affiliate_id
    and link.product_id = product.id
    and link.is_main
    and link.status = 'active'
  order by link.created_at desc, link.id desc
  limit 1
) as main_link on true
left join public.platform_settings as setting on setting.singleton
where membership.user_id = auth.uid()
  and membership.active
  and affiliate.status in ('active', 'paused');

alter function public.issue_admin_main_link(jsonb) rename to issue_admin_main_link_before_short_urls;
revoke all on function public.issue_admin_main_link_before_short_urls(jsonb) from public,anon,authenticated,service_role;
create function public.issue_admin_main_link(p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$declare result jsonb;begin
 result:=public.issue_admin_main_link_before_short_urls(p_input);
 return result||jsonb_build_object('short_url',kma_internal.ensure_tracking_link_alias((result->>'id')::uuid));
end;$$;
revoke all on function public.issue_admin_main_link(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.issue_admin_main_link(jsonb) to authenticated;

alter function public.get_admin_product_configuration(uuid) rename to get_admin_product_configuration_before_short_urls;
revoke all on function public.get_admin_product_configuration_before_short_urls(uuid) from public,anon,authenticated,service_role;
create function public.get_admin_product_configuration(p_product_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$declare result jsonb;begin
 result:=public.get_admin_product_configuration_before_short_urls(p_product_id);
 return jsonb_set(result,'{main_links}',coalesce((select jsonb_agg(link||jsonb_build_object('short_url',kma_internal.tracking_link_short_url((link->>'id')::uuid)))
  from jsonb_array_elements(result->'main_links') as link),'[]'::jsonb));
end;$$;
revoke all on function public.get_admin_product_configuration(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_admin_product_configuration(uuid) to authenticated;

revoke all on function kma_internal.readable_handle(text,text,integer),kma_internal.ensure_tracking_link_alias(uuid),kma_internal.tracking_link_short_url(uuid),kma_internal.protect_tracking_alias_identity() from public,anon,authenticated,service_role;
commit;
