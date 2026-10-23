-- Generic, signed journey telemetry. This migration enables no provider or payment gate.
begin;
create table public.funnel_journey_configuration (
 funnel_id uuid primary key references public.funnels,
 environment text not null check(environment in('test','live')),
 conversion_window_days integer not null default 30 check(conversion_window_days between 1 and 365),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid references auth.users
);
create table public.funnel_journey_clicks (
 click_record_id uuid primary key references public.clicks,
 environment text not null check(environment in('test','live')),
 classified_at timestamptz not null default clock_timestamp()
);
create table public.funnel_journey_identities (
 product_id uuid not null references public.products,funnel_id uuid not null references public.funnels,
 environment text not null check(environment in('test','live')),subject_id text not null,
 canonical_subject_id text not null,click_record_id uuid not null references public.clicks,
 verified boolean not null default false,created_at timestamptz not null default clock_timestamp(),
 primary key(product_id,funnel_id,environment,subject_id),
 check(subject_id~'^[A-Za-z0-9_-]{16,128}$' and canonical_subject_id~'^[A-Za-z0-9_-]{16,128}$')
);
alter table public.funnel_metric_events add column journey_environment text check(journey_environment in('test','live')),add column business_key text;
create unique index funnel_journey_business_event on public.funnel_metric_events(product_id,funnel_id,journey_environment,business_key) where business_key is not null;
create index funnel_journey_identity_scope on public.funnel_journey_identities(funnel_id,environment,canonical_subject_id);
create index funnel_journey_event_scope on public.funnel_metric_events(funnel_id,journey_environment,subject_id,occurred_at);
alter table public.funnel_journey_configuration enable row level security;
alter table public.funnel_journey_clicks enable row level security;
alter table public.funnel_journey_identities enable row level security;
revoke all on public.funnel_journey_configuration,public.funnel_journey_clicks,public.funnel_journey_identities from public,anon,authenticated,service_role;
grant select on public.funnel_journey_configuration,public.funnel_journey_clicks,public.funnel_journey_identities to service_role;
create trigger funnel_journey_click_immutable before update or delete on public.funnel_journey_clicks for each row execute function kma_internal.external_commerce_immutable();

create function public.configure_admin_funnel_journey(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare f uuid; days integer; env text; result jsonb; prior timestamptz;
begin
 if not public.current_user_is_admin(array['owner','operations']) then raise exception 'Owner or operations access required' using errcode='42501';end if;
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) k where k<>all(array['funnel_id','environment','conversion_window_days','expected_updated_at'])) then raise exception 'Invalid journey configuration' using errcode='22023';end if;
 f:=(p_input->>'funnel_id')::uuid;env:=p_input->>'environment';days:=coalesce((p_input->>'conversion_window_days')::integer,30);
 if f is null or env is null or env not in('test','live') or days not between 1 and 365 then raise exception 'Choose funnel, environment and reporting window' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('journey-config:'||f::text,0));
 select updated_at into prior from public.funnel_journey_configuration where funnel_id=f for update;
 if prior is distinct from (p_input->>'expected_updated_at')::timestamptz then raise exception 'Journey configuration changed; reload before saving' using errcode='40001';end if;
 insert into public.funnel_journey_configuration(funnel_id,environment,conversion_window_days,updated_by) values(f,env,days,auth.uid()) on conflict(funnel_id) do update set environment=excluded.environment,conversion_window_days=excluded.conversion_window_days,updated_at=clock_timestamp(),updated_by=auth.uid() returning to_jsonb(funnel_journey_configuration.*) into result;
 return result;
end;$$;
create function public.get_admin_funnel_journey_configuration(p_funnel_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.current_user_is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
 if not exists(select 1 from public.funnels where id=p_funnel_id) then raise exception 'Funnel not found' using errcode='P0002';end if;
 return (select to_jsonb(c) from public.funnel_journey_configuration c where funnel_id=p_funnel_id);
end;$$;
create function kma_internal.classify_journey_click() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.funnel_journey_clicks(click_record_id,environment) select new.id,c.environment from public.funnel_journey_configuration c where c.funnel_id=new.funnel_id;
 return new;
end;$$;
create trigger funnel_journey_click_created after insert on public.clicks for each row execute function kma_internal.classify_journey_click();

-- Retain the exact v1 contract and validation of previously queued deliveries.
alter function public.validate_funnel_metric_event(jsonb,boolean) rename to validate_funnel_metric_event_v1;
create function public.validate_funnel_metric_event(p_event jsonb,p_sample boolean default false) returns boolean language plpgsql stable set search_path='' as $$
declare k text; extra text[]:=array['schema_version','environment','dedupe_key','aliased_subject_id','anonymous_id','order_id','checkout_session_id','assessment_attempt_id','registration_id','group_id','resource_id','event_source','funnel_version','entry_route','utm_source','utm_medium','utm_campaign','host_type','request_source','state_revision'];
begin
 if not(p_event ? 'schema_version') then return public.validate_funnel_metric_event_v1(p_event,p_sample);end if;
 if p_event->>'schema_version'<>'2' or p_event->>'environment' is null or p_event->>'environment' not in('test','live') or coalesce(p_event->>'dedupe_key','')!~'^[A-Za-z0-9_.:-]{1,160}$' or pg_column_size(p_event)>8192 or exists(select 1 from jsonb_each(p_event) x where jsonb_typeof(x.value)<>'string') then raise exception 'Journey v2 requires environment and stable business key' using errcode='22023';end if;
 if p_event ? 'state_revision' and coalesce(p_event->>'state_revision','')!~'^[1-9][0-9]{0,8}$' then raise exception 'State revision must be a positive bounded integer' using errcode='22023';end if;
 perform public.validate_funnel_metric_event_v1(p_event-extra,p_sample);
 foreach k in array extra[4:array_length(extra,1)] loop
 if p_event ? k and coalesce(p_event->>k,'')!~'^[A-Za-z0-9_-]{1,128}$' then raise exception 'Journey references must be opaque codes' using errcode='22023';end if;
 end loop;
 foreach k in array array['aliased_subject_id','anonymous_id'] loop if p_event ? k and coalesce(p_event->>k,'')!~'^[A-Za-z0-9_-]{16,128}$' then raise exception 'Identity references must be opaque' using errcode='22023';end if;end loop;
 if (p_event ? 'aliased_subject_id' or p_event->>'event_name'='identity_linked') and (p_event->>'event_name' is distinct from 'identity_linked' or p_event->>'state_value' is distinct from 'verified' or not(p_event ? 'aliased_subject_id') or p_event->>'aliased_subject_id'=p_event->>'subject_id') then raise exception 'Identity link requires verified ownership and distinct previous subject' using errcode='22023';end if;
 if p_event->>'event_name'=any(array['purchase_completed','refund_status_updated','payment_status_updated','dispute_status_updated','commission_status_updated','payout_status_updated']) then raise exception 'Financial truth requires verified commerce ingestion' using errcode='22023';end if;
 return true;
end;$$;
alter function public.ingest_funnel_metric_event(uuid,uuid,jsonb) rename to ingest_funnel_metric_event_v1;
create function public.ingest_funnel_metric_event(p_product_id uuid,p_funnel_id uuid,p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.clicks; a public.acquisitions; prior public.funnel_metric_events; i public.funnel_journey_identities; old_i public.funnel_journey_identities; saved uuid; env text:=p_event->>'environment'; defs jsonb;
 catalog constant text[]:=array['affiliate_link_clicked','landing_page_viewed','lead_created','email_lead','email_verified','identity_linked','consent_updated','attribution_updated','resource_opened','resource_accessed','resource_download_requested','resource_served','assessment_started','assessment_completed','availability_saved','webinar_invitation_requested','webinar_requested','webinar_registered','webinar_join_clicked','webinar_attendance_updated','webinar_attendance','checkout_created','checkout_opened','checkout_redirected','checkout_cancel_returned','checkout_expired','checkout_closed','matching_pool_entered','matching_status_updated','pool_state','group_confirmed','cohort_state'];
begin
 if not(p_event ? 'schema_version') then return public.ingest_funnel_metric_event_v1(p_product_id,p_funnel_id,p_event);end if;
 perform public.validate_funnel_metric_event(p_event);
 perform public.assert_funnel_request_scope('metric-ingress',p_event->>'click_id',p_product_id,p_funnel_id);
 select * into c from public.clicks where public_click_id=p_event->>'click_id';
 select * into a from public.acquisitions where click_record_id=c.id and product_id=p_product_id and funnel_id=p_funnel_id and status in('open','resolved') order by created_at,id limit 1;
 if c.id is null or a.id is null or c.affiliate_id is distinct from a.affiliate_id or c.is_bot then raise exception 'Valid attributed click required' using errcode='22023';end if;
 if (p_event->>'occurred_at')::timestamptz<c.occurred_at-interval '5 minutes' then raise exception 'Journey event predates its acquisition click' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('journey:'||p_product_id::text||p_funnel_id::text||env,0));
 select * into prior from public.funnel_metric_events where product_id=p_product_id and funnel_id=p_funnel_id and (external_event_id=(p_event->>'event_id')::uuid or (journey_environment=env and business_key=p_event->>'dedupe_key')) order by received_at limit 1;
 if found then
 if prior.evidence-'event_id' is distinct from p_event-'event_id' then raise exception 'Event identity already has different evidence' using errcode='23505';end if;
 return jsonb_build_object('event_id',prior.id,'duplicate',true);
 end if;
 if not(p_event->>'event_name'=any(catalog)) then
 select metrics into defs from public.funnel_metric_versions where funnel_id=p_funnel_id and archived_at is null;
 if defs is null or not exists(select 1 from jsonb_array_elements(defs) m where m->>'event_name'=p_event->>'event_name') then raise exception 'Unknown journey event; configure a custom metric definition first' using errcode='22023';end if;
 end if;
 insert into public.funnel_journey_clicks(click_record_id,environment) values(c.id,env) on conflict do nothing;
 if exists(select 1 from public.funnel_journey_clicks where click_record_id=c.id and environment<>env) then raise exception 'Click environment cannot change' using errcode='23505';end if;
 insert into public.funnel_journey_identities(product_id,funnel_id,environment,subject_id,canonical_subject_id,click_record_id) values(p_product_id,p_funnel_id,env,p_event->>'subject_id',p_event->>'subject_id',c.id) on conflict do nothing;
 select * into i from public.funnel_journey_identities where product_id=p_product_id and funnel_id=p_funnel_id and environment=env and subject_id=p_event->>'subject_id';
 if i.click_record_id<>c.id then raise exception 'Credited acquisition is immutable across return visits' using errcode='23505';end if;
 if p_event->>'event_name'='identity_linked' then
 insert into public.funnel_journey_identities(product_id,funnel_id,environment,subject_id,canonical_subject_id,click_record_id) values(p_product_id,p_funnel_id,env,p_event->>'aliased_subject_id',p_event->>'aliased_subject_id',c.id) on conflict do nothing;
 select * into old_i from public.funnel_journey_identities where product_id=p_product_id and funnel_id=p_funnel_id and environment=env and subject_id=p_event->>'aliased_subject_id';
 if old_i.click_record_id<>c.id or (old_i.verified and old_i.canonical_subject_id<>i.canonical_subject_id) then raise exception 'Identity linkage cannot replace a verified identity or credited click' using errcode='23505';end if;
 update public.funnel_journey_identities set canonical_subject_id=i.canonical_subject_id,verified=true where product_id=p_product_id and funnel_id=p_funnel_id and environment=env and canonical_subject_id in(old_i.canonical_subject_id,i.canonical_subject_id);
 elsif p_event->>'event_name'='email_verified' then update public.funnel_journey_identities set verified=true where product_id=p_product_id and funnel_id=p_funnel_id and environment=env and canonical_subject_id=i.canonical_subject_id;
 end if;
 insert into public.funnel_metric_events(external_event_id,product_id,funnel_id,affiliate_id,link_id,click_record_id,acquisition_id,event_name,subject_id,context_id,session_id,state_value,occurred_at,presence_expires_at,evidence,journey_environment,business_key)
 values((p_event->>'event_id')::uuid,p_product_id,p_funnel_id,c.affiliate_id,c.affiliate_link_id,c.id,a.id,p_event->>'event_name',p_event->>'subject_id',p_event->>'context_id',p_event->>'session_id',p_event->>'state_value',(p_event->>'occurred_at')::timestamptz,(p_event->>'presence_expires_at')::timestamptz,p_event,env,p_event->>'dedupe_key') returning id into saved;
 return jsonb_build_object('event_id',saved,'duplicate',false);
end;$$;

-- Journey is a click-acquisition cohort; all subsequent outcomes retain that
-- cohort, rather than dividing today's purchases by today's new leads.
create function kma_internal.funnel_journey_report(p_product uuid,p_funnel uuid,p_affiliate uuid,p_link uuid,p_start timestamptz,p_end timestamptz,p_environment text,p_days integer,p_currency text,p_filters jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
with all_clicks as (
 select c.*,j.environment from public.clicks c left join public.funnel_journey_clicks j on j.click_record_id=c.id
 where c.product_id=p_product and c.funnel_id=p_funnel and (p_affiliate is null or c.affiliate_id=p_affiliate) and (p_link is null or c.affiliate_link_id=p_link)
 and not c.is_bot and c.occurred_at>=p_start and c.occurred_at<p_end and c.occurred_at<=statement_timestamp()
), clicks as (
 select c.* from all_clicks c where c.environment=p_environment and (p_filters='{}' or exists(select 1 from public.funnel_metric_events e where e.click_record_id=c.id and e.journey_environment=p_environment and e.evidence @> p_filters))
), raw_events as (
 select e.*,i.canonical_subject_id person from public.funnel_metric_events e join clicks c on c.id=e.click_record_id
 join public.funnel_journey_identities i on i.product_id=e.product_id and i.funnel_id=e.funnel_id and i.environment=e.journey_environment and i.subject_id=e.subject_id
 where e.journey_environment=p_environment and e.occurred_at>=c.occurred_at-interval '5 minutes' and e.occurred_at<=least(statement_timestamp(),c.occurred_at+make_interval(days=>p_days))
), events as (
 select e.* from raw_events e where p_filters='{}' or exists(select 1 from raw_events f where f.person=e.person and f.evidence @> p_filters)
), orders as (
 select o.*,purchase.provider_occurred_at paid_at,
 coalesce(identity.canonical_subject_id,known.subject_id) person,
 least(o.amount_minor,greatest(coalesce((select sum(r.amount_minor) from public.external_commerce_events r where r.order_id=o.id and r.kind='refund' and r.provider_occurred_at<=statement_timestamp()),0),coalesce((select sum(r.amount_minor) from public.external_commission_adjustments r where r.order_id=o.id and r.kind='refund' and r.occurred_at<=statement_timestamp()),0))) refunded,
 coalesce(a.commission_minor,0) commission,
 coalesce(a.reversed_minor,0) reversed,
 coalesce(a.status,'unconfigured') award_status,
 coalesce((select sum(si.amount_minor) from public.external_settlement_items si join public.external_settlement_batches b on b.id=si.batch_id where si.award_id=a.id and b.status='transferred'),0)
 -coalesce((select sum(j.amount_minor) from public.external_settlement_jobs j where j.order_id=o.id and j.kind='reversal' and j.state='succeeded'),0) transferred
 from public.external_commerce_orders o join clicks c on c.id=o.click_record_id
 join public.external_commerce_events purchase on purchase.order_id=o.id and purchase.kind='purchase'
 left join public.external_commission_awards a on a.order_id=o.id
 left join lateral (
 select ei.subject_id from public.external_order_eligibility_identity ei where ei.order_id=o.id
 union all select e.subject_id from events e where e.evidence->>'order_id'=o.external_order_id::text and e.click_record_id=o.click_record_id
 union all select m.learner_id from public.managed_checkout_orders m where m.external_order_id=o.external_order_id and m.product_id=o.product_id and m.funnel_id=o.funnel_id and m.account_id=o.stripe_account_id and m.livemode=o.livemode
 limit 1
 ) known on true
 left join public.funnel_journey_identities identity on identity.product_id=o.product_id and identity.funnel_id=o.funnel_id and identity.environment=p_environment and identity.subject_id=known.subject_id and identity.click_record_id=o.click_record_id
 where o.product_id=p_product and o.funnel_id=p_funnel and o.livemode=(p_environment='live') and (p_currency is null or o.currency=p_currency)
 and purchase.provider_occurred_at>=c.occurred_at and purchase.provider_occurred_at<=least(statement_timestamp(),c.occurred_at+make_interval(days=>p_days))
 and (p_filters='{}' or exists(select 1 from events e where e.person=coalesce(identity.canonical_subject_id,known.subject_id)))
 and (not(p_filters ? 'intake_id') or exists(select 1 from public.external_order_eligibility_identity ei where ei.order_id=o.id and ei.dimensions->>'intake_id'=p_filters->>'intake_id')
 or exists(select 1 from public.managed_checkout_orders m where m.external_order_id=o.external_order_id and m.account_id=o.stripe_account_id and m.livemode=o.livemode and m.context->>'intake_id'=p_filters->>'intake_id')
 or exists(select 1 from events e where e.click_record_id=o.click_record_id and e.evidence->>'order_id'=o.external_order_id::text and e.evidence->>'intake_id'=p_filters->>'intake_id'))
), people as (
 select person from events union select person from orders where person is not null
), times as (
 select p.person,
 min(e.occurred_at) filter(where e.event_name='landing_page_viewed') landing,
 min(e.occurred_at) filter(where e.event_name in('lead_created','email_lead')) lead,
 min(e.occurred_at) filter(where e.event_name='email_verified') verified,
 min(e.occurred_at) filter(where e.event_name='assessment_started') assessment_start,
 min(e.occurred_at) filter(where e.event_name='assessment_completed') assessment_complete,
 min(e.occurred_at) filter(where e.event_name='availability_saved') availability,
 min(e.occurred_at) filter(where e.event_name in('webinar_invitation_requested','webinar_requested')) invitation,
 min(e.occurred_at) filter(where e.event_name='webinar_registered' and (not(p_filters ? 'webinar_id') or e.evidence->>'webinar_id'=p_filters->>'webinar_id')) registered,
 min(e.occurred_at) filter(where e.event_name in('checkout_created','checkout_opened')) checkout,
 min(e.occurred_at) filter(where e.event_name='checkout_cancel_returned') cancelled,
 min(e.occurred_at) filter(where e.event_name in('resource_opened','resource_accessed','resource_served')) resource,
 min(e.occurred_at) filter(where (e.event_name='matching_pool_entered' or (e.event_name='pool_state' and e.state_value in('waiting','matched','paid'))) and (not(p_filters ? 'intake_id') or e.evidence->>'intake_id'=p_filters->>'intake_id')) pool,
 min(e.occurred_at) filter(where (e.event_name='group_confirmed' or (e.event_name='cohort_state' and e.state_value='confirmed')) and (not(p_filters ? 'intake_id') or e.evidence->>'intake_id'=p_filters->>'intake_id')) confirmed,
 (select min(o.paid_at) from orders o where o.person=p.person) paid
 from people p left join events e on e.person=p.person group by p.person
), attendance as (
 select distinct on(person,coalesce(evidence->>'webinar_id',context_id)) person,coalesce(evidence->>'webinar_id',context_id) webinar,state_value,occurred_at
 from events where event_name in('webinar_attendance','webinar_attendance_updated') and (not(p_filters ? 'webinar_id') or evidence->>'webinar_id'=p_filters->>'webinar_id')
 order by person,coalesce(evidence->>'webinar_id',context_id),coalesce((evidence->>'state_revision')::integer,0) desc,occurred_at desc,received_at desc,external_event_id desc
), classified as (
 select t.*,exists(select 1 from attendance a where a.person=t.person and a.state_value='attended') attended,
 exists(select 1 from attendance a where a.person=t.person and a.state_value='missed') missed,
 exists(select 1 from attendance a where a.person=t.person and a.state_value='unknown') unknown_attendance,
 exists(select 1 from events reg join attendance a on a.person=reg.person and a.webinar=coalesce(reg.evidence->>'webinar_id',reg.context_id) and a.state_value='attended' and a.occurred_at>=reg.occurred_at where reg.person=t.person and reg.event_name='webinar_registered') registered_attended,
 exists(select 1 from attendance a join orders o on o.person=a.person and o.paid_at>=a.occurred_at where a.person=t.person and a.state_value='attended') attendee_purchased,
 exists(select 1 from events cancel join events invite on invite.person=cancel.person and invite.occurred_at>=cancel.occurred_at and invite.event_name in('webinar_requested','webinar_invitation_requested') where cancel.person=t.person and cancel.event_name='checkout_cancel_returned') cancelled_invited,
 exists(select 1 from events cancel join attendance a on a.person=cancel.person and a.occurred_at>=cancel.occurred_at and a.state_value='attended' where cancel.person=t.person and cancel.event_name='checkout_cancel_returned') cancelled_attended,
 exists(select 1 from events cancel join attendance a on a.person=cancel.person and a.occurred_at>=cancel.occurred_at and a.state_value='attended' join orders o on o.person=a.person and o.paid_at>=a.occurred_at where cancel.person=t.person and cancel.event_name='checkout_cancel_returned') recovered
 from times t
), stats as (
 select count(*) filter(where landing is not null) visitors,count(*) filter(where lead is not null) leads,count(*) filter(where verified is not null) verified,
 count(*) filter(where assessment_start is not null) assessment_started,count(*) filter(where assessment_complete is not null) assessment_completed,
 count(*) filter(where availability is not null) availability_saved,count(*) filter(where invitation is not null) invitation_requested,
 count(*) filter(where registered is not null) registered,count(*) filter(where attended) attended,count(*) filter(where missed and not attended) attendance_missed,
 count(*) filter(where registered is not null and not attended and not missed) attendance_unknown,
 count(*) filter(where checkout is not null) checkout_started,count(*) filter(where cancelled is not null) cancelled_checkout,
 count(*) filter(where paid is not null) paid,count(*) filter(where pool>=paid) matching_pool,count(*) filter(where confirmed>=paid) group_confirmed,
 count(*) filter(where lead>=landing) landing_leads,count(*) filter(where registered>=lead) lead_registered,
 count(*) filter(where registered_attended) registered_attended,count(*) filter(where assessment_complete>=assessment_start) assessment_finished,
 count(*) filter(where resource>=lead) engaged_leads,count(*) filter(where attendee_purchased) attendee_purchased,
 count(*) filter(where paid>=lead) lead_purchased,count(*) filter(where paid>=checkout) checkout_purchased,
 count(*) filter(where cancelled_invited) cancelled_invited,count(*) filter(where cancelled_attended) cancelled_attended,count(*) filter(where recovered) recovered
 from classified
), rate_rows as (
 select r.* from stats s cross join lateral (values
 ('landing_to_signup','Landing page → email signup',s.landing_leads,s.visitors),
 ('click_to_signup','Creator click → email signup',s.leads,(select count(*) from clicks)),
 ('signup_to_registration','Email signup → webinar registration',s.lead_registered,s.leads),
 ('registration_to_attendance','Webinar registration → attendance',s.registered_attended,s.registered),
 ('assessment_completion','Assessment completion',s.assessment_finished,s.assessment_started),
 ('resource_engagement','Resource engagement',s.engaged_leads,s.leads),
 ('webinar_to_purchase','Webinar attendance → purchase',s.attendee_purchased,s.attended),
 ('signup_to_purchase','Email signup → purchase',s.lead_purchased,s.leads),
 ('checkout_to_purchase','Checkout → purchase',s.checkout_purchased,s.checkout_started),
 ('cancelled_to_invitation','Cancelled checkout → webinar invitation',s.cancelled_invited,s.cancelled_checkout),
 ('webinar_recovery','Webinar recovery',s.recovered,s.cancelled_attended)
 ) r(key,label,numerator,denominator)
), order_paths as (
 select o.id,case
 when exists(select 1 from events c join events inv on inv.person=c.person and inv.event_name in('webinar_invitation_requested','webinar_requested') and inv.occurred_at>=c.occurred_at
 join events reg on reg.person=inv.person and reg.event_name='webinar_registered' and reg.occurred_at>=inv.occurred_at
 join attendance a on a.person=reg.person and a.webinar=coalesce(reg.evidence->>'webinar_id',reg.context_id) and a.state_value='attended' and a.occurred_at>=reg.occurred_at
 where c.person=o.person and c.event_name='checkout_cancel_returned' and a.occurred_at<=o.paid_at) then 'cancelled_webinar_payment'
 when exists(select 1 from attendance a join events ass on ass.person=a.person and ass.event_name='assessment_completed' and ass.occurred_at>=a.occurred_at where a.person=o.person and a.state_value='attended' and ass.occurred_at<=o.paid_at) then 'webinar_assessment_payment'
 when exists(select 1 from attendance a where a.person=o.person and a.state_value='attended' and a.occurred_at<=o.paid_at) then 'webinar_payment'
 when exists(select 1 from events e where e.person=o.person and e.event_name='assessment_completed' and e.occurred_at<=o.paid_at) then 'assessment_payment'
 when o.person is not null then 'pay_first' else 'unlinked' end path
 from orders o
), commerce as (
 select currency,count(*) paid_orders,count(*) filter(where refunded>0) refunded_orders,sum(amount_minor) collected_minor,sum(refunded) refunded_minor,
 sum(commission) filter(where award_status='held' and transferred<=0) pending_commission_minor,
 sum(commission) filter(where award_status='eligible' or transferred>0) approved_commission_minor,
 sum(greatest(0,transferred)) paid_commission_minor,sum(reversed) reversed_commission_minor,
 count(*) filter(where award_status='unconfigured') unconfigured_commission_orders
 from orders group by currency
)
select jsonb_build_object(
 'schema_version',2,'environment',p_environment,'conversion_window_days',p_days,'cohort_from',p_start,'cohort_to',p_end,
 'observed_until',statement_timestamp(),'immature',exists(select 1 from clicks where occurred_at+make_interval(days=>p_days)>statement_timestamp()),
 'valid_clicks',(select count(*) from clicks),'unclassified_clicks',(select count(*) from all_clicks where environment is null),
 'learners',(select to_jsonb(s)-array['landing_leads','lead_registered','registered_attended','assessment_finished','engaged_leads','attendee_purchased','lead_purchased','checkout_purchased','cancelled_invited','cancelled_attended','recovered'] from stats s),
 'rates',coalesce((select jsonb_agg(jsonb_build_object('key',key,'label',label,'numerator',numerator,'denominator',denominator,'value',round(numerator*100.0/nullif(denominator,0),2),'status',case when denominator=0 then 'zero_denominator' else 'available' end)) from rate_rows),'[]'),
 'paths',(select jsonb_agg(jsonb_build_object('key',p.key,'label',p.label,'orders',(select count(*) from order_paths o where o.path=p.key))) from (values
 ('assessment_payment','Assessment → payment'),('webinar_assessment_payment','Webinar → assessment → payment'),('webinar_payment','Webinar → payment'),('cancelled_webinar_payment','Cancelled checkout → webinar → payment'),('pay_first','Payment first'),('unlinked','Identity unavailable')) p(key,label)),
 'commerce',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('pending_commission_minor',coalesce(pending_commission_minor,0),'approved_commission_minor',coalesce(approved_commission_minor,0),
 'refund_rate',round(refunded_orders*100.0/nullif(paid_orders,0),2),'refunded_revenue_rate',round(refunded_minor*100.0/nullif(collected_minor,0),2),
 'approved_epc_minor',round(coalesce(approved_commission_minor,0)*1.0/nullif((select count(*) from clicks),0),4),
 'pending_epc_minor',round(coalesce(pending_commission_minor,0)*1.0/nullif((select count(*) from clicks),0),4),
 'earnings_per_1000_clicks_minor',round(coalesce(approved_commission_minor,0)*1000.0/nullif((select count(*) from clicks),0),2)) order by currency) from commerce c),'[]'),
 'warnings',jsonb_build_array(
 'Journey conversions follow the same valid creator-click cohort within the reporting window. This window never changes signed commission attribution terms.',
 'Recent cohorts may still convert. Historical clicks without an explicit environment are excluded, never assumed to be live.',
 'Approved earnings include amounts already transferred. Transfers are a subset of earnings, not additional earnings, and do not prove a bank payout.',
 'Purchases and successful refunds come only from verified commerce records. Refunds adjust their original orders even after the conversion window.',
 'Pending and unconfigured commission is not approved income. Unknown attendance is not a confirmed no-show.',
 'Latest traffic and email sources never replace the credited creator. Reports contain internal references, not learner email addresses.'
 ));
$$;

alter function public.funnel_metrics_report(jsonb,boolean) rename to funnel_metrics_report_v1;
create function public.funnel_metrics_report(p_input jsonb,p_admin boolean) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb; env text; days integer; currency text; affiliate uuid; filters jsonb; starts timestamptz; ends timestamptz; journey jsonb;
begin
 -- v1 enforces product membership, creator self-scope, dates, dimensions and links.
 base:=public.funnel_metrics_report_v1(p_input-array['environment','conversion_window_days','currency'],p_admin);
 env:=coalesce(p_input->>'environment','live');days:=coalesce((p_input->>'conversion_window_days')::integer,(select conversion_window_days from public.funnel_journey_configuration where funnel_id=(p_input->>'funnel_id')::uuid),30);currency:=p_input->>'currency';
 if env not in('test','live') or days not between 1 and 365 or (currency is not null and currency!~'^[A-Z]{3}$') then raise exception 'Invalid journey report scope' using errcode='22023';end if;
 affiliate:=case when p_admin then nullif(p_input->>'affiliate_id','')::uuid else public.current_partner_affiliate_id(false) end;
 starts:=(p_input->>'date_from')::date::timestamp at time zone coalesce(p_input->>'time_zone','UTC');ends:=((p_input->>'date_to')::date+1)::timestamp at time zone coalesce(p_input->>'time_zone','UTC');
 filters:=p_input-array['product_id','funnel_id','date_from','date_to','time_zone','link_id','version','affiliate_id','environment','conversion_window_days','currency'];
 journey:=kma_internal.funnel_journey_report((p_input->>'product_id')::uuid,(p_input->>'funnel_id')::uuid,affiliate,nullif(p_input->>'link_id','')::uuid,starts,ends,env,days,currency,filters);
 if p_input ? 'environment' or p_input ? 'currency' then base:=jsonb_set(base,'{commerce,currencies}',coalesce((select jsonb_agg(x) from jsonb_array_elements(base#>'{commerce,currencies}') x where (not(p_input ? 'environment') or (x->>'livemode')::boolean=(env='live')) and (currency is null or x->>'currency'=currency)),'[]'));end if;
 return base||jsonb_build_object('journey',journey);
end;$$;

revoke all on function public.validate_funnel_metric_event_v1(jsonb,boolean),public.ingest_funnel_metric_event_v1(uuid,uuid,jsonb),public.funnel_metrics_report_v1(jsonb,boolean),public.funnel_metrics_report(jsonb,boolean),public.validate_funnel_metric_event(jsonb,boolean),public.ingest_funnel_metric_event(uuid,uuid,jsonb),public.configure_admin_funnel_journey(jsonb),kma_internal.classify_journey_click(),kma_internal.funnel_journey_report(uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,integer,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.ingest_funnel_metric_event(uuid,uuid,jsonb) to service_role;
revoke all on function public.get_admin_funnel_journey_configuration(uuid) from public,anon,authenticated,service_role;
grant execute on function public.configure_admin_funnel_journey(jsonb),public.get_admin_funnel_journey_configuration(uuid) to authenticated;
commit;
