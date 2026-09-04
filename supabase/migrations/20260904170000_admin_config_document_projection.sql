-- The product-configuration read must return each agreement's current
-- document so the browser shows the signing timeline. This replaces the
-- duplicated agreement projection inside get_admin_product_configuration
-- with the shared enrichment that the create/activate mutations already use.

create or replace function public.get_admin_product_configuration(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  product_record public.products%rowtype;
  tracking_record public.platform_settings%rowtype;
  viewer_can_manage_routing boolean;
  tracking_only_ready_value boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication is required' using errcode = '28000';
  end if;
  if not public.current_user_is_admin(
    array['owner', 'operations', 'finance', 'analyst']::text[]
  ) then
    raise exception 'admin role cannot view product configuration' using errcode = '42501';
  end if;

  viewer_can_manage_routing := public.current_user_is_admin(array['owner', 'operations']::text[]);

  select * into product_record
  from public.products as product
  where product.id = p_product_id;
  if product_record.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;

  select * into tracking_record
  from public.platform_settings as setting
  where setting.singleton;
  tracking_only_ready_value := public.tracking_only_product_is_ready(p_product_id);

  return jsonb_build_object(
    'product', jsonb_build_object(
      'id', product_record.id,
      'slug', product_record.slug,
      'name', product_record.name,
      'status', product_record.status,
      'tracking_mode', product_record.tracking_mode,
      'tracking_only_funnel_id', product_record.tracking_only_funnel_id,
      'tracking_only_approved_by', product_record.tracking_only_approved_by,
      'tracking_only_approved_at', product_record.tracking_only_approved_at,
      'created_at', product_record.created_at,
      'updated_at', product_record.updated_at
    ) || case
      when viewer_can_manage_routing then jsonb_build_object(
        'tracking_only_destination_url_snapshot',
        product_record.tracking_only_destination_url_snapshot
      )
      else '{}'::jsonb
    end,
    'tracking', jsonb_build_object(
      'enabled', coalesce(tracking_record.tracking_enabled, false),
      'base_url', tracking_record.tracking_base_url
    ),
    'readiness', jsonb_build_object(
      'has_live_default_funnel', exists (
        select 1 from public.funnels as funnel
        where funnel.product_id = p_product_id
          and funnel.is_default
          and funnel.status = 'live'
          and funnel.destination_url is not null
      ),
      'has_active_agreement', exists (
        select 1 from public.agreements as agreement
        where agreement.product_id = p_product_id and agreement.status = 'active'
      ),
      'has_active_billing_offer', public.product_has_launch_ready_billing_offer(p_product_id),
      'tracking_only_ready', tracking_only_ready_value,
      'tracking_only_can_issue_links',
        product_record.tracking_mode = 'tracking_only'
        and product_record.status = 'active'
        and tracking_only_ready_value
        and coalesce(tracking_record.tracking_enabled, false)
        and tracking_record.tracking_base_url = 'https://go.kissmyapps.dev',
      'commercial_ready',
        product_record.tracking_mode = 'commercial'
        and exists (
          select 1 from public.agreements as agreement
          where agreement.product_id = p_product_id
            and public.agreement_is_launch_ready(agreement.id, now())
        )
        and public.product_has_launch_ready_billing_offer(p_product_id),
      'tracking_ready',
        coalesce(tracking_record.tracking_enabled, false)
        and tracking_record.tracking_base_url = 'https://go.kissmyapps.dev'
        and (
          (
            product_record.tracking_mode = 'tracking_only'
            and tracking_only_ready_value
          )
          or (
            product_record.tracking_mode = 'commercial'
            and exists (
              select 1 from public.agreements as agreement
              where agreement.product_id = p_product_id
                and public.agreement_is_launch_ready(agreement.id, now())
            )
            and public.product_has_launch_ready_billing_offer(p_product_id)
          )
        )
    ),
    'funnels', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', funnel.id,
          'product_id', funnel.product_id,
          'key', funnel.key,
          'name', funnel.name,
          'destination_configured', funnel.destination_url is not null,
          'is_default', funnel.is_default,
          'status', funnel.status,
          'created_at', funnel.created_at,
          'updated_at', funnel.updated_at
        ) || case
          when viewer_can_manage_routing then
            jsonb_build_object('destination_url', funnel.destination_url)
          else '{}'::jsonb
        end
        order by funnel.is_default desc, funnel.name, funnel.id
      )
      from public.funnels as funnel
      where funnel.product_id = p_product_id
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(to_jsonb(campaign) order by campaign.name, campaign.id)
      from public.campaigns as campaign
      where campaign.product_id = p_product_id
    ), '[]'::jsonb),
    'agreements', coalesce((
      select jsonb_agg(
        public.admin_agreement_enriched(agreement)
        order by affiliate.public_name, agreement.version desc, agreement.id
      )
      from public.agreements as agreement
      join public.affiliates as affiliate on affiliate.id = agreement.affiliate_id
      where agreement.product_id = p_product_id
    ), '[]'::jsonb),
    'billing_offers', coalesce((
      select jsonb_agg(
        (to_jsonb(offer)
          - 'verified_stripe_price_id'
          - 'verified_currency'
          - 'verified_unit_amount_minor'
          - 'verified_billing_mode')
        || jsonb_build_object(
          'stripe_price_verified',
            offer.stripe_livemode_verified_at is not null
            and offer.verified_stripe_price_id is not distinct from offer.stripe_price_id
            and offer.verified_currency is not distinct from offer.currency
            and offer.verified_unit_amount_minor is not distinct from offer.unit_amount_minor
            and offer.verified_billing_mode = offer.billing_mode
        )
        order by offer.key, offer.version desc, offer.id
      )
      from public.billing_offers as offer
      where offer.product_id = p_product_id
    ), '[]'::jsonb),
    'main_links', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', link.id,
          'affiliate_id', link.affiliate_id,
          'partner_name', affiliate.public_name,
          'funnel_id', link.funnel_id,
          'status', link.status,
          'tracking_url', link.tracking_url,
          'commercial_eligible', link.commercial_eligible,
          'created_at', link.created_at
        ) order by affiliate.public_name, link.created_at, link.id
      )
      from public.affiliate_links as link
      join public.affiliates as affiliate on affiliate.id = link.affiliate_id
      where link.product_id = p_product_id and link.is_main
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_admin_product_configuration(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_admin_product_configuration(uuid) to authenticated;

comment on function public.get_admin_product_configuration(uuid) is
  'Protected product configuration read. Agreement rows share the admin_agreement_enriched projection, including the current signing document.';
