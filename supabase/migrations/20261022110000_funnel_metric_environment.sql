-- Scope published event cards by the explicitly selected environment. Unknown
-- historical events remain unclassified; omitted mode retains compatibility.
-- V2 cards use verified aliases and operational state revisions, just as the
-- journey report does. This changes no card definitions, financial data or gates.
begin;
create or replace function kma_internal.filtered_metric_rows(p_product uuid,p_funnel uuid,p_affiliate uuid,p_link uuid,p_effective_from timestamptz,p_effective_until timestamptz,p_samples jsonb,p_filters jsonb)
returns table(event_name text,subject_id text,context_id text,session_id text,state_value text,occurred_at timestamptz,presence_expires_at timestamptz,received_at timestamptz,tie_break text,dimensions jsonb)
language sql stable security definer set search_path='' as $$
 select e.event_name,
 case when e.journey_environment is null then e.subject_id else e.journey_environment||':'||coalesce(identity.canonical_subject_id,e.subject_id) end,
 case when e.journey_environment is not null and e.event_name in('webinar_attendance','webinar_attendance_updated') then coalesce(e.evidence->>'webinar_id',e.context_id) else e.context_id end,e.session_id,e.state_value,e.occurred_at,e.presence_expires_at,e.received_at,e.external_event_id::text,e.evidence
 from public.funnel_metric_events e
 left join public.funnel_journey_identities identity on identity.product_id=e.product_id and identity.funnel_id=e.funnel_id and identity.environment=e.journey_environment and identity.subject_id=e.subject_id
 where p_samples is null and e.product_id=p_product and e.funnel_id=p_funnel and (p_affiliate is null or e.affiliate_id=p_affiliate) and (p_link is null or e.link_id=p_link) and e.occurred_at>=p_effective_from and (p_effective_until is null or e.occurred_at<p_effective_until)
 and (not(p_filters?'environment') or e.journey_environment=p_filters->>'environment')
 and e.evidence @> (p_filters-'environment')
 union all
 select x->>'event_name',x->>'subject_id',x->>'context_id',x->>'session_id',x->>'state_value',(x->>'occurred_at')::timestamptz,(x->>'presence_expires_at')::timestamptz,(x->>'occurred_at')::timestamptz,coalesce(x->>'event_id',lpad(n::text,12,'0')),x
 from jsonb_array_elements(coalesce(p_samples,'[]')) with ordinality as s(x,n) where p_samples is not null and x @> p_filters;
$$;
create or replace function kma_internal.filtered_compute_metrics(p_metrics jsonb,p_product uuid,p_funnel uuid,p_affiliate uuid,p_link uuid,p_start timestamptz,p_end timestamptz,p_effective_from timestamptz,p_effective_until timestamptz,p_asof timestamptz,p_samples jsonb,p_filters jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m jsonb; result jsonb:='[]'; vals jsonb:='{}'; n numeric; numerator numeric; denominator numeric; seen timestamptz; availability text; t text;
begin
 for m in select value from jsonb_array_elements(p_metrics) loop
 n:=null; seen:=null; availability:='available'; t:=m->>'type';
 if t='ratio' then
 numerator:=(vals->(m->>'numerator_key')->>'value')::numeric; denominator:=(vals->(m->>'denominator_key')->>'value')::numeric;
 if numerator is null or denominator is null then availability:='awaiting_data'; elsif denominator=0 then availability:='zero_denominator'; else n:=round(100*numerator/denominator,2); end if;
 else
 select max(r.received_at) into seen from kma_internal.filtered_metric_rows(p_product,p_funnel,p_affiliate,p_link,p_effective_from,p_effective_until,p_samples,case when p_filters?'environment' then jsonb_build_object('environment',p_filters->>'environment') else '{}'::jsonb end) r where r.event_name=m->>'event_name';
 if seen is null and p_samples is null then availability:='awaiting_data'; else
 if t='current_state' then
 select count(*) into n from (select distinct on(r.subject_id,coalesce(r.context_id,'')) r.state_value,r.dimensions from kma_internal.filtered_metric_rows(p_product,p_funnel,p_affiliate,p_link,p_effective_from,p_effective_until,p_samples,case when p_filters?'environment' then jsonb_build_object('environment',p_filters->>'environment') else '{}'::jsonb end) r where r.event_name=m->>'event_name' and r.occurred_at<=p_asof order by r.subject_id,coalesce(r.context_id,''),case when r.dimensions->>'schema_version'='2' then coalesce((r.dimensions->>'state_revision')::integer,0) else 0 end desc,r.occurred_at desc,r.tie_break desc) latest where latest.state_value=m->>'state_value' and latest.dimensions @> p_filters;
 elsif t='live_presence' then
 select count(distinct (latest.subject_id,latest.context_id)) into n from (select distinct on(r.subject_id,r.context_id,r.session_id) r.subject_id,r.context_id,r.state_value,r.presence_expires_at,r.dimensions from kma_internal.filtered_metric_rows(p_product,p_funnel,p_affiliate,p_link,p_effective_from,p_effective_until,p_samples,case when p_filters?'environment' then jsonb_build_object('environment',p_filters->>'environment') else '{}'::jsonb end) r where r.event_name=m->>'event_name' and r.occurred_at<=p_asof order by r.subject_id,r.context_id,r.session_id,r.occurred_at desc,r.tie_break desc) latest where latest.state_value='active' and latest.presence_expires_at>p_asof and latest.dimensions @> p_filters;
 else
 select case t when 'event_count' then count(*) when 'unique_people' then count(distinct r.subject_id) when 'unique_per_context' then count(distinct (r.subject_id,r.context_id)) filter(where r.context_id is not null) end into n from kma_internal.filtered_metric_rows(p_product,p_funnel,p_affiliate,p_link,p_effective_from,p_effective_until,p_samples,p_filters) r where r.event_name=m->>'event_name' and r.occurred_at>=p_start and r.occurred_at<p_end and r.occurred_at<=p_asof;
 end if;
 end if;
 end if;
 vals:=vals||jsonb_build_object(m->>'key',jsonb_build_object('value',n));
 result:=result||jsonb_build_array(jsonb_build_object('key',m->>'key','label',m->>'label','type',t,'visible',coalesce((m->>'visible')::boolean,true),'value',n,'availability',availability,'last_received_at',seen));
 end loop; return result;
end;$$;
create or replace function public.funnel_metrics_report_v1(p_input jsonb,p_admin boolean) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare product uuid; funnel uuid; affiliate uuid; link uuid; dfrom date; dto date; tz text; starts timestamptz; ends timestamptz; asof timestamptz; v public.funnel_metric_versions; values_json jsonb; latest timestamptz; commerce jsonb; commerce_latest timestamptz; commerce_connected boolean; currencies jsonb; filters jsonb; k text;
begin
 if p_admin then if not public.current_user_is_admin() then raise exception 'Admin access required' using errcode='42501'; end if; affiliate:=nullif(p_input->>'affiliate_id','')::uuid;
 else affiliate:=public.current_partner_affiliate_id(false); if p_input ? 'affiliate_id' then raise exception 'Creator reports are self scoped' using errcode='42501'; end if; end if;
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) x where x<>all(array['product_id','funnel_id','date_from','date_to','time_zone','link_id','version','affiliate_id','context_id','channel','entry_variant','webinar_id','intake_id','environment'])) then raise exception 'Invalid report filters' using errcode='22023'; end if;
 if p_input?'environment' and (p_input->>'environment' is null or p_input->>'environment' not in('test','live')) then raise exception 'Choose test or live reporting environment' using errcode='22023';end if;
 filters:=p_input-array['product_id','funnel_id','date_from','date_to','time_zone','link_id','version','affiliate_id'];
 for k in select jsonb_object_keys(filters) loop if jsonb_typeof(filters->k)<>'string' or coalesce(filters->>k,'')!~'^[A-Za-z0-9_-]{1,128}$' then raise exception 'Use opaque reporting dimension IDs' using errcode='22023';end if;end loop;
 product:=(p_input->>'product_id')::uuid; funnel:=(p_input->>'funnel_id')::uuid; link:=nullif(p_input->>'link_id','')::uuid;
 if product is null or funnel is null or not exists(select 1 from public.funnels f where f.id=funnel and f.product_id=product) then raise exception 'Choose a funnel from this product' using errcode='22023'; end if;
 if not p_admin and not public.current_user_can_view_product(product) then raise exception 'Product access denied' using errcode='42501'; end if;
 if link is not null and not exists(select 1 from public.affiliate_links l where l.id=link and l.product_id=product and l.funnel_id=funnel and (affiliate is null or l.affiliate_id=affiliate)) then raise exception 'Link outside report scope' using errcode='42501'; end if;
 tz:=coalesce(p_input->>'time_zone','UTC');
 if not exists(select 1 from pg_catalog.pg_timezone_names where name=tz) or coalesce(p_input->>'date_from','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(p_input->>'date_to','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'A valid date range and IANA timezone are required' using errcode='22023'; end if;
 dfrom:=(p_input->>'date_from')::date; dto:=(p_input->>'date_to')::date;
 if dto<dfrom or dto-dfrom>366 then raise exception 'Choose a range of at most 367 days' using errcode='22023'; end if;
 starts:=dfrom::timestamp at time zone tz; ends:=(dto+1)::timestamp at time zone tz; asof:=least(ends-interval '1 microsecond',statement_timestamp());
 select * into v from public.funnel_metric_versions where funnel_id=funnel and (not(p_input ? 'version') or version=(p_input->>'version')::integer) order by version desc limit 1;
 if p_input ? 'version' and v.version is null then raise exception 'Published version not found' using errcode='P0002'; end if;
 asof:=least(asof,coalesce(v.archived_at-interval '1 microsecond',asof));
 values_json:=coalesce(kma_internal.filtered_compute_metrics(coalesce(v.metrics,'[]'),product,funnel,affiliate,link,starts,ends,v.published_at,v.archived_at,least(asof,coalesce(v.archived_at-interval '1 microsecond',asof)),null,filters),'[]');
 if not p_admin then select coalesce(jsonb_agg(x),'[]') into values_json from jsonb_array_elements(values_json) x where (x->>'visible')::boolean; end if;
 select max(e.received_at) into latest from public.funnel_metric_events e where e.product_id=product and e.funnel_id=funnel and (affiliate is null or e.affiliate_id=affiliate) and (link is null or e.link_id=link) and e.occurred_at>=v.published_at and (v.archived_at is null or e.occurred_at<v.archived_at) and (not(filters?'environment') or e.journey_environment=filters->>'environment');
 select exists(select 1 from public.external_commerce_merchants m where m.product_id=product and m.funnel_id=funnel and m.enabled and (not(filters?'environment') or m.livemode=(filters->>'environment'='live'))) into commerce_connected;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into currencies from (
 select o.currency,o.livemode,count(*) filter(where e.kind='purchase') as purchases,count(*) filter(where e.kind='refund') as refunds,
 coalesce(sum(e.amount_minor) filter(where e.kind='purchase'),0) as gross_minor,coalesce(sum(e.amount_minor) filter(where e.kind='refund'),0) as refunded_minor,
 sum(case when e.kind='purchase' then e.amount_minor else -e.amount_minor end) as net_minor
 from public.external_commerce_orders o join public.external_commerce_events e on e.order_id=o.id join public.clicks click on click.id=o.click_record_id
 where o.product_id=product and o.funnel_id=funnel and (affiliate is null or o.affiliate_id=affiliate) and (link is null or click.affiliate_link_id=link) and ((filters-'environment')='{}'::jsonb or exists(select 1 from public.external_order_eligibility_identity ident where ident.order_id=o.id and ident.dimensions @> (filters-'environment'))) and (not(filters?'environment') or o.livemode=(filters->>'environment'='live')) and e.provider_occurred_at>=starts and e.provider_occurred_at<ends group by o.currency,o.livemode order by o.currency,o.livemode) c;
 select max(e.created_at) into commerce_latest from public.external_commerce_orders o join public.external_commerce_events e on e.order_id=o.id join public.clicks click on click.id=o.click_record_id where o.product_id=product and o.funnel_id=funnel and (affiliate is null or o.affiliate_id=affiliate) and (link is null or click.affiliate_link_id=link) and (not(filters?'environment') or o.livemode=(filters->>'environment'='live'));
 commerce:=jsonb_build_object('source','external_verified_ledger','availability',case when commerce_connected or commerce_latest is not null then 'available' else 'unconnected' end,'commission_status','held','currencies',currencies,'last_received_at',commerce_latest);
 return jsonb_build_object('product_id',product,'funnel_id',funnel,'version',v.version,'published_at',v.published_at,'effective_until',v.archived_at,'as_of',asof,'last_received_at',latest,'status',case when v.version is null then 'unpublished' when latest is null then 'awaiting_data' else 'connected' end,'metrics',values_json,'commerce',commerce,'filters',filters,'warnings',jsonb_build_array('Ratios compare the configured event counts in this reporting period; they are not acquisition-cohort conversion rates.','Dimension-filtered sales include only orders with verified matching context evidence.'));
end;$$;
create or replace function public.funnel_metrics_report(p_input jsonb,p_admin boolean) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb; env text; days integer; currency text; affiliate uuid; filters jsonb; starts timestamptz; ends timestamptz; journey jsonb;
begin
 -- v1 enforces product membership, creator self-scope, dates, dimensions and links.
 base:=public.funnel_metrics_report_v1(p_input-array['conversion_window_days','currency'],p_admin);
 env:=coalesce(p_input->>'environment','live');days:=coalesce((p_input->>'conversion_window_days')::integer,(select conversion_window_days from public.funnel_journey_configuration where funnel_id=(p_input->>'funnel_id')::uuid),30);currency:=p_input->>'currency';
 if env not in('test','live') or days not between 1 and 365 or (currency is not null and currency!~'^[A-Z]{3}$') then raise exception 'Invalid journey report scope' using errcode='22023';end if;
 affiliate:=case when p_admin then nullif(p_input->>'affiliate_id','')::uuid else public.current_partner_affiliate_id(false) end;
 starts:=(p_input->>'date_from')::date::timestamp at time zone coalesce(p_input->>'time_zone','UTC');ends:=((p_input->>'date_to')::date+1)::timestamp at time zone coalesce(p_input->>'time_zone','UTC');
 filters:=p_input-array['product_id','funnel_id','date_from','date_to','time_zone','link_id','version','affiliate_id','environment','conversion_window_days','currency'];
 journey:=kma_internal.funnel_journey_report((p_input->>'product_id')::uuid,(p_input->>'funnel_id')::uuid,affiliate,nullif(p_input->>'link_id','')::uuid,starts,ends,env,days,currency,filters);
 if p_input ? 'environment' or p_input ? 'currency' then base:=jsonb_set(base,'{commerce,currencies}',coalesce((select jsonb_agg(x) from jsonb_array_elements(base#>'{commerce,currencies}') x where (not(p_input ? 'environment') or (x->>'livemode')::boolean=(env='live')) and (currency is null or x->>'currency'=currency)),'[]'));end if;
 return base||jsonb_build_object('journey',journey);
end;$$;

revoke all on function kma_internal.filtered_metric_rows(uuid,uuid,uuid,uuid,timestamptz,timestamptz,jsonb,jsonb),kma_internal.filtered_compute_metrics(jsonb,uuid,uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,jsonb,jsonb),public.funnel_metrics_report_v1(jsonb,boolean),public.funnel_metrics_report(jsonb,boolean) from public,anon,authenticated,service_role;
commit;
