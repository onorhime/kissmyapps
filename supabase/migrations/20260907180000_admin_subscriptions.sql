-- Read-only subscription directory. No billing actions, new evidence or base-table grants.
begin;
create function public.get_admin_subscriptions(
  p_query text default null, p_status text default null, p_product_id uuid default null,
  p_limit integer default 25, p_offset integer default 0, p_sort text default 'newest'
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; needle text:=lower(trim(coalesce(p_query,'')));
begin
  perform public.assert_admin_password(array['owner','operations','finance','analyst']::text[], 'view subscriptions');
  if length(needle)>120 or (p_status is not null and p_status not in ('incomplete','trialing','active','past_due','cancelled','unpaid'))
    or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000
    or p_sort is null or p_sort not in ('newest','oldest') then
    raise exception 'invalid subscription filters' using errcode='22023'; end if;
  with filtered as materialized (
    select s.*, p.name as product_name, a.public_name as partner_name,
      ac.affiliate_id, ac.source_id, ac.campaign_id, ac.funnel_id, ac.click_record_id
    from public.subscriptions s join public.products p on p.id=s.product_id
    left join public.acquisitions ac on ac.id=s.acquisition_id and ac.product_id=s.product_id
    left join public.affiliates a on a.id=ac.affiliate_id
    where (p_status is null or s.status::text=p_status) and (p_product_id is null or s.product_id=p_product_id)
      and (needle='' or strpos(lower(s.stripe_subscription_id),needle)>0
        or strpos(lower(p.name),needle)>0 or strpos(lower(coalesce(a.public_name,'')),needle)>0
        or strpos(s.account_id::text,needle)>0)
  ), page as (
    select * from filtered order by
      case when p_sort='newest' then created_at end desc,
      case when p_sort='oldest' then created_at end asc, id
    limit p_limit offset p_offset
  )
  select jsonb_build_object('generated_at',statement_timestamp(),
    'stripe_work_pending',exists(select 1 from public.provider_events e
      left join public.provider_event_processing q on q.provider_event_id=e.id
      where e.provider='stripe' and q.status is distinct from 'processed'::public.processing_status),
    'total',(select count(*) from filtered),
    'summary',(select jsonb_build_object('active',count(*) filter(where status='active'),
      'trialing',count(*) filter(where status='trialing'),
      'payment_attention',count(*) filter(where status in ('past_due','unpaid','incomplete')),
      'cancelled',count(*) filter(where status='cancelled')) from filtered),
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'stripe_subscription_id',s.stripe_subscription_id,'account_id',s.account_id,
      'product_id',s.product_id,'product_name',s.product_name,'partner_name',s.partner_name,
      'status',s.status,'currency',s.currency,'created_at',s.created_at,'updated_at',s.updated_at,
      'period_start',s.current_period_starts_at,'period_end',s.current_period_ends_at,'cancelled_at',s.cancelled_at,
      'source_name',source.name,'campaign_name',campaign.name,'funnel_name',funnel.name,
      'sub1',click.sub1,'sub2',click.sub2,'sub3',click.sub3,
      'acquisition_id',s.acquisition_id,'affiliate_id',s.affiliate_id,
      'evidence_at',evidence.last_event_created_at,'offer_name',offer.name,
      'checkout_list_amount_minor',attempt.unit_amount_minor,
      'zero_total_checkout',exists(select 1 from public.events ev
        where ev.source='stripe' and ev.event_name='checkout.no_payment_required'
          and ev.product_id=s.product_id and ev.account_id=s.account_id
          and ev.acquisition_id=s.acquisition_id and ev.properties->>'subscription_id'=s.stripe_subscription_id),
      'recorded_paid_invoices',(select count(*) from public.transactions t where t.subscription_id=s.id and t.gross_minor>0)
    ) order by case when p_sort='newest' then s.created_at end desc,
      case when p_sort='oldest' then s.created_at end asc,s.id)
    from page s
    left join public.sources source on source.id=s.source_id
    left join public.campaigns campaign on campaign.id=s.campaign_id and campaign.product_id=s.product_id
    left join public.funnels funnel on funnel.id=s.funnel_id and funnel.product_id=s.product_id
    left join public.clicks click on click.id=s.click_record_id and click.product_id=s.product_id
    left join public.stripe_subscription_evidence evidence on evidence.subscription_id=s.id
    left join public.checkout_attempts attempt on attempt.id=evidence.checkout_attempt_id
      and attempt.product_id=s.product_id and attempt.currency=s.currency
    left join public.billing_offers offer on offer.id=attempt.billing_offer_id),'[]'::jsonb)) into result;
  return result;
end $$;
revoke all on function public.get_admin_subscriptions(text,text,uuid,integer,integer,text) from public,anon,service_role;
grant execute on function public.get_admin_subscriptions(text,text,uuid,integer,integer,text) to authenticated;
commit;
