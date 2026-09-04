-- Product deletion for pre-launch cleanup, plus the curated global source
-- catalog so administrators no longer create the standard channels by hand.

-- Known traffic channels shared by every product. Idempotent: existing keys
-- are left untouched.
insert into public.sources (key, name)
values
  ('tiktok', 'TikTok'),
  ('instagram', 'Instagram'),
  ('youtube', 'YouTube'),
  ('x', 'X (Twitter)'),
  ('facebook', 'Facebook'),
  ('reddit', 'Reddit'),
  ('newsletter', 'Newsletter'),
  ('email', 'Email'),
  ('blog', 'Blog / SEO'),
  ('discord', 'Discord'),
  ('telegram', 'Telegram'),
  ('threads', 'Threads')
on conflict (key) do nothing;

create or replace function public.delete_admin_product(p_input jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  allowed_keys constant text[] := array['product_id', 'confirmation'];
  product_id_value uuid;
  confirmation_value text;
  product_record public.products%rowtype;
  stored public.products%rowtype;
begin
  perform public.assert_admin_password(array['owner', 'operations']::text[], 'delete a product');

  if p_input is null or jsonb_typeof(p_input) <> 'object'
     or not (p_input ?& allowed_keys)
     or exists (
       select 1 from jsonb_object_keys(p_input) as input_key
       where input_key <> all(allowed_keys)
     ) then
    raise exception 'delete input must contain exactly product_id and confirmation' using errcode = '22023';
  end if;
  if jsonb_typeof(p_input -> 'product_id') <> 'string'
     or jsonb_typeof(p_input -> 'confirmation') <> 'string' then
    raise exception 'delete input values are invalid' using errcode = '22023';
  end if;

  begin
    product_id_value := nullif(trim(p_input ->> 'product_id'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'product_id must be a UUID' using errcode = '22023';
  end;
  confirmation_value := trim(p_input ->> 'confirmation');

  select * into product_record
  from public.products as product
  where product.id = product_id_value
  for update;
  if product_record.id is null then
    raise exception 'product not found' using errcode = 'P0002';
  end if;
  if lower(confirmation_value) <> lower(product_record.slug) then
    raise exception 'type the exact product slug to confirm deletion' using errcode = '22023';
  end if;

  -- Real commercial facts make a product permanent history.
  if exists (select 1 from public.checkout_attempts as row where row.product_id = product_record.id)
     or exists (select 1 from public.subscriptions as row where row.product_id = product_record.id)
     or exists (select 1 from public.entitlements as row where row.product_id = product_record.id)
     or exists (select 1 from public.conversions as row where row.product_id = product_record.id)
     or exists (select 1 from public.commission_entries as row where row.product_id = product_record.id)
     or exists (select 1 from public.payouts as row where row.product_id = product_record.id)
     or exists (select 1 from public.commercial_transaction_states as row where row.product_id = product_record.id)
     or exists (select 1 from public.commercial_source_applications as row where row.product_id = product_record.id)
     or exists (
       select 1 from public.events as row
       where row.product_id = product_record.id and row.commercial_eligible
     )
     or exists (
       select 1 from public.affiliate_daily_metrics as row
       where row.product_id = product_record.id
         and (
           row.purchases <> 0 or row.renewals <> 0 or row.cancellations <> 0
           or row.activations <> 0 or row.refunds <> 0 or row.disputes <> 0
           or row.gross_collected_minor <> 0 or row.eligible_revenue_minor <> 0
           or row.earnings_minor <> 0 or row.active_subscriptions <> 0
           or row.is_subscription_snapshot
         )
     ) then
    raise exception 'this product already has commercial records (purchases, commissions, payouts, or entitlements) and cannot be deleted'
      using errcode = 'P0001';
  end if;

  -- Preserved bilateral evidence blocks deletion like any commercial record.
  if exists (
    select 1 from public.documents as document
    join public.agreements as agreement on agreement.id = document.agreement_id
    where agreement.product_id = product_record.id
      and document.status in ('signed', 'active')
  ) then
    raise exception 'a fully signed agreement document for this product is preserved as evidence and cannot be deleted'
      using errcode = 'P0001';
  end if;

  delete from public.affiliate_daily_metrics as row
  where row.product_id = product_record.id;
  delete from public.commercial_metric_refresh_queue as row
  where row.product_id = product_record.id;
  delete from public.events as row
  where row.product_id = product_record.id;
  delete from public.acquisitions as row
  where row.product_id = product_record.id;
  delete from public.clicks as row
  where row.product_id = product_record.id;
  delete from public.affiliate_links as row
  where row.product_id = product_record.id;
  delete from public.documents as document
  where document.agreement_id in (
    select agreement.id from public.agreements as agreement
    where agreement.product_id = product_record.id
  );
  delete from public.commission_rules as rule
  where rule.agreement_id in (
    select agreement.id from public.agreements as agreement
    where agreement.product_id = product_record.id
  );
  delete from public.agreements as row
  where row.product_id = product_record.id;
  delete from public.billing_offers as row
  where row.product_id = product_record.id;
  delete from public.campaigns as row
  where row.product_id = product_record.id;
  delete from public.funnels as row
  where row.product_id = product_record.id;
  delete from public.products as row
  where row.id = product_record.id
  returning * into stored;

  insert into public.audit_logs (
    actor_user_id, actor_type, action, target_table, target_id, metadata
  ) values (
    auth.uid(), 'admin', 'product.delete', 'products', stored.id,
    jsonb_build_object('slug', stored.slug, 'name', stored.name)
  );

  return to_jsonb(stored);
end;
$$;

revoke all on function public.delete_admin_product(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_admin_product(jsonb) to authenticated;

comment on function public.delete_admin_product(jsonb) is
  'Owner/Operations password-authenticated deletion of a pre-launch product with its funnel, campaign, agreement, rule, offer, link, and tracking rows. Blocked once any commercial fact exists (purchases, commissions, payouts, entitlements, signed evidence). Requires the exact product slug as confirmation.';
