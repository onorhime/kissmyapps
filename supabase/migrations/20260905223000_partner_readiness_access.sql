-- Partner views may call only membership-scoped readiness wrappers.
-- Do not grant the original internal helpers or base tables to browser roles.
create or replace function public.partner_agreement_is_launch_ready(p_agreement_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  partner_id uuid;
begin
  if auth.uid() is null or p_agreement_id is null then return false; end if;
  select agreement.affiliate_id into partner_id
  from public.agreements as agreement where agreement.id = p_agreement_id;
  if partner_id is null or not public.current_user_has_affiliate(partner_id) then
    return false;
  end if;
  return public.agreement_is_launch_ready(p_agreement_id, statement_timestamp());
end;
$$;

create or replace function public.partner_tracking_only_product_is_ready(p_product_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_product_id is null then return false; end if;
  -- Mirror the product directory's ownership scope, including historical
  -- associations. Never reveal readiness of an unrelated product ID.
  if not exists (
    select 1
    from public.affiliate_users as membership
    join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
    where membership.user_id = auth.uid()
      and membership.active
      and membership.role in ('owner', 'finance', 'analyst', 'member')
      and affiliate.status in ('active', 'paused')
      and (
        exists (select 1 from public.agreements as agreement
          where agreement.affiliate_id = membership.affiliate_id and agreement.product_id = p_product_id)
        or exists (select 1 from public.affiliate_links as link
          where link.affiliate_id = membership.affiliate_id and link.product_id = p_product_id)
        or exists (select 1 from public.payouts as payout
          where payout.affiliate_id = membership.affiliate_id and payout.product_id = p_product_id)
        or exists (select 1 from public.affiliate_daily_metrics as metric
          where metric.affiliate_id = membership.affiliate_id and metric.product_id = p_product_id)
      )
  ) then return false; end if;
  return public.tracking_only_product_is_ready(p_product_id);
end;
$$;

revoke all on function public.partner_agreement_is_launch_ready(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.partner_tracking_only_product_is_ready(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.partner_agreement_is_launch_ready(uuid) to authenticated;
grant execute on function public.partner_tracking_only_product_is_ready(uuid) to authenticated;

comment on function public.partner_agreement_is_launch_ready(uuid) is
  'Read-only partner readiness for an agreement belonging to the current active membership. Internal launch helper stays private.';
comment on function public.partner_tracking_only_product_is_ready(uuid) is
  'Read-only tracking readiness for a product associated with the current active partner membership. No routing destination is exposed.';

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
  main_link.id as main_link_id
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

create or replace view public.partner_link_option_directory
with (security_barrier = true)
as
with eligible_products as materialized (
  select distinct
    membership.affiliate_id,
    product.id as product_id,
    product.tracking_mode,
    product.tracking_only_funnel_id
  from public.affiliate_users as membership
  join public.affiliates as affiliate on affiliate.id = membership.affiliate_id
  join public.products as product on product.status = 'active'
  left join public.platform_settings as setting on setting.singleton
  where membership.user_id = auth.uid()
    and membership.active
    and affiliate.status = 'active'
    and setting.tracking_enabled
    and setting.tracking_base_url = 'https://go.kissmyapps.dev'
    and (
      (
        product.tracking_mode = 'commercial'
        and exists (
          select 1 from public.agreements as agreement
          where agreement.affiliate_id = membership.affiliate_id
            and agreement.product_id = product.id
            and public.partner_agreement_is_launch_ready(agreement.id)
        )
      )
      or (
        product.tracking_mode = 'tracking_only'
        and public.partner_tracking_only_product_is_ready(product.id)
        and exists (
          select 1 from public.affiliate_links as link
          where link.affiliate_id = membership.affiliate_id
            and link.product_id = product.id
            and link.is_main
            and link.status = 'active'
            and not link.commercial_eligible
        )
      )
    )
)
select
  funnel.id,
  'funnel'::text as kind,
  funnel.product_id,
  funnel.key,
  funnel.name,
  (
    funnel.status = 'live'
    and (
      eligible.tracking_mode = 'commercial'
      or funnel.id = eligible.tracking_only_funnel_id
    )
  ) as available
from eligible_products as eligible
join public.funnels as funnel on funnel.product_id = eligible.product_id
union all
select
  campaign.id,
  'campaign'::text,
  campaign.product_id,
  campaign.key,
  campaign.name,
  (campaign.status = 'active')
from eligible_products as eligible
join public.campaigns as campaign on campaign.product_id = eligible.product_id
union all
select
  source.id,
  'source'::text,
  null::uuid,
  source.key,
  source.name,
  source.active
from public.sources as source
where source.active
  and exists (select 1 from eligible_products);


