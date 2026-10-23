-- Explicit, versioned journeys for any product. Financial truth remains in the
-- verified commerce ledger. This migration enables no checkout or payout gate.
begin;
create function kma_internal.validate_funnel_journey_definition(p_definition jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare item jsonb; stage jsonb; name jsonb; category text; key text; source text; keys text[]:='{}'; report_keys text[]:='{}'; seen_names text[]; steps text[];
begin
 if jsonb_typeof(p_definition) is distinct from 'object' or not(p_definition ?& array['stages','rates','paths']) or exists(select 1 from jsonb_object_keys(p_definition) k where k<>all(array['stages','rates','paths'])) or pg_column_size(p_definition)>65536 then raise exception 'Provide stages, rates and paths only, within 64 KiB' using errcode='22023';end if;
 foreach category in array array['stages','rates','paths'] loop
 if jsonb_typeof(p_definition->category) is distinct from 'array' or jsonb_array_length(p_definition->category)>20 then raise exception 'Each journey section supports at most 20 definitions' using errcode='22023';end if;
 end loop;
 for stage in select value from jsonb_array_elements(p_definition->'stages') loop
 key:=stage->>'key';source:=stage->>'source';
 if jsonb_typeof(stage) is distinct from 'object' or exists(select 1 from jsonb_object_keys(stage) k where k<>all(array['key','label','source','event_names','state_value','context_field'])) or key is null or key!~'^[a-z][a-z0-9_]{0,79}$' or key=any(keys) or jsonb_typeof(stage->'label') is distinct from 'string' or length(btrim(stage->>'label'))<1 or length(stage->>'label')>120 or source is null or source not in('event','purchase') then raise exception 'Invalid or duplicate journey stage' using errcode='22023';end if;
 if exists(select 1 from jsonb_each(stage) e where e.key<>'event_names' and jsonb_typeof(e.value)<>'string') then raise exception 'Journey stage values must be strings' using errcode='22023';end if;
 if source='purchase' then
 if stage ?| array['event_names','state_value','context_field'] then raise exception 'Purchase stages come only from verified orders' using errcode='22023';end if;
 else
 if jsonb_typeof(stage->'event_names') is distinct from 'array' or jsonb_array_length(stage->'event_names') not between 1 and 8 then raise exception 'Event stages need one to eight event names' using errcode='22023';end if;
 seen_names:='{}';
 for name in select value from jsonb_array_elements(stage->'event_names') loop
 if jsonb_typeof(name)<>'string' or (name#>>'{}')!~'^[a-z][a-z0-9_]{0,79}$' or (name#>>'{}')=any(seen_names) or (name#>>'{}')=any(array['purchase_completed','refund_status_updated','payment_status_updated','dispute_status_updated','commission_status_updated','payout_status_updated','identity_linked']) then raise exception 'Invalid, duplicate or reserved journey event name' using errcode='22023';end if;
 seen_names:=array_append(seen_names,name#>>'{}');
 end loop;
 if stage?'state_value' and coalesce(stage->>'state_value','')!~'^[a-z][a-z0-9_]{0,49}$' then raise exception 'Invalid journey state value' using errcode='22023';end if;
 if stage?'context_field' and coalesce(stage->>'context_field','')<>all(array['context_id','webinar_id','intake_id','assessment_attempt_id']) then raise exception 'Choose a documented context field' using errcode='22023';end if;
 end if;
 keys:=array_append(keys,key);
 end loop;
 foreach category in array array['rates','paths'] loop
 report_keys:='{}';
 for item in select value from jsonb_array_elements(p_definition->category) loop
 key:=item->>'key';
 if jsonb_typeof(item) is distinct from 'object' or exists(select 1 from jsonb_object_keys(item) k where k<>all(array['key','label','steps'])) or jsonb_typeof(item->'key') is distinct from 'string' or key!~'^[a-z][a-z0-9_]{0,79}$' or key=any(report_keys) or jsonb_typeof(item->'label') is distinct from 'string' or length(btrim(item->>'label'))<1 or length(item->>'label')>120 or jsonb_typeof(item->'steps') is distinct from 'array' or jsonb_array_length(item->'steps') not between 2 and 8 then raise exception 'Journey rates and paths need a unique key, label and two to eight ordered stages' using errcode='22023';end if;
 steps:='{}';
 for name in select value from jsonb_array_elements(item->'steps') loop
 if jsonb_typeof(name)<>'string' or not((name#>>'{}')=any(keys)) or (name#>>'{}')=any(steps) then raise exception 'Journey steps must reference existing stages without repetition' using errcode='22023';end if;
 steps:=array_append(steps,name#>>'{}');
 end loop;
 report_keys:=array_append(report_keys,key);
 end loop;
 end loop;
 return true;
end;$$;
create table public.funnel_journey_definition_drafts (
 funnel_id uuid primary key references public.funnels,
 revision integer not null default 0 check(revision>=0),
 template text not null default 'blank' check(template in('blank','sales','webinar','custom')),
 definition jsonb not null default '{"stages":[],"rates":[],"paths":[]}' check(kma_internal.validate_funnel_journey_definition(definition)),
 updated_at timestamptz not null default clock_timestamp(),updated_by uuid references auth.users
);
create table public.funnel_journey_definition_versions (
 funnel_id uuid not null references public.funnels,version integer not null check(version>0),
 template text not null check(template in('blank','sales','webinar','custom')),
 definition jsonb not null check(kma_internal.validate_funnel_journey_definition(definition)),
 published_at timestamptz not null,archived_at timestamptz,published_by uuid references auth.users,
 primary key(funnel_id,version),check(archived_at is null or archived_at>=published_at)
);
create unique index funnel_journey_definition_active on public.funnel_journey_definition_versions(funnel_id) where archived_at is null;
alter table public.funnel_journey_definition_drafts enable row level security;
alter table public.funnel_journey_definition_versions enable row level security;
revoke all on public.funnel_journey_definition_drafts,public.funnel_journey_definition_versions from public,anon,authenticated,service_role;
grant select on public.funnel_journey_definition_drafts,public.funnel_journey_definition_versions to service_role;
create trigger funnel_journey_definition_immutable before update or delete on public.funnel_journey_definition_versions for each row execute function public.guard_funnel_metric_version();

create function public.get_admin_funnel_journey_definition(p_funnel_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare draft jsonb; published jsonb; versions jsonb;
begin
 if not public.current_user_is_admin() then raise exception 'Admin access required' using errcode='42501';end if;
 if not exists(select 1 from public.funnels where id=p_funnel_id) then raise exception 'Funnel not found' using errcode='P0002';end if;
 select jsonb_build_object('revision',d.revision,'template',d.template,'definition',d.definition) into draft from public.funnel_journey_definition_drafts d where d.funnel_id=p_funnel_id;
 select jsonb_build_object('version',v.version,'template',v.template,'published_at',v.published_at,'definition',v.definition) into published from public.funnel_journey_definition_versions v where v.funnel_id=p_funnel_id and v.archived_at is null;
 select coalesce(jsonb_agg(jsonb_build_object('version',v.version,'template',v.template,'published_at',v.published_at,'archived_at',v.archived_at) order by v.version desc),'[]') into versions from public.funnel_journey_definition_versions v where v.funnel_id=p_funnel_id;
 return jsonb_build_object('funnel_id',p_funnel_id,'draft',coalesce(draft,'{"revision":0,"template":"blank","definition":{"stages":[],"rates":[],"paths":[]}}'::jsonb),'published',published,'versions',versions);
end;$$;
create function public.save_admin_funnel_journey_definition(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f uuid; r integer; t text; stored integer;
begin
 if not public.current_user_is_admin(array['owner','operations']) then raise exception 'Journey editing requires owner or operations access' using errcode='42501';end if;
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) k where k<>all(array['funnel_id','expected_revision','template','definition'])) then raise exception 'Invalid journey draft input' using errcode='22023';end if;
 f:=(p_input->>'funnel_id')::uuid;r:=(p_input->>'expected_revision')::integer;t:=p_input->>'template';
 if f is null or r is null or r<0 or t is null or t not in('blank','sales','webinar','custom') then raise exception 'Invalid journey draft identity' using errcode='22023';end if;
 if not exists(select 1 from public.funnels where id=f) then raise exception 'Funnel not found' using errcode='P0002';end if;
 perform kma_internal.validate_funnel_journey_definition(p_input->'definition');
 perform pg_advisory_xact_lock(hashtextextended('funnel-journey-definition:'||f::text,0));
 insert into public.funnel_journey_definition_drafts(funnel_id) values(f) on conflict do nothing;
 select revision into stored from public.funnel_journey_definition_drafts where funnel_id=f for update;
 if stored<>r then raise exception 'Journey draft changed; reload before saving' using errcode='40001';end if;
 update public.funnel_journey_definition_drafts set revision=revision+1,template=t,definition=p_input->'definition',updated_at=clock_timestamp(),updated_by=auth.uid() where funnel_id=f;
 return public.get_admin_funnel_journey_definition(f);
end;$$;
create function public.publish_admin_funnel_journey_definition(p_input jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare f uuid; r integer; d public.funnel_journey_definition_drafts; v integer; ts timestamptz:=clock_timestamp();
begin
 if not public.current_user_is_admin(array['owner','operations']) then raise exception 'Publishing journeys requires owner or operations access' using errcode='42501';end if;
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) k where k<>all(array['funnel_id','expected_revision'])) then raise exception 'Invalid journey publish input' using errcode='22023';end if;
 f:=(p_input->>'funnel_id')::uuid;r:=(p_input->>'expected_revision')::integer;
 if f is null or r is null or r<0 then raise exception 'Invalid journey publish identity' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('funnel-journey-definition:'||f::text,0));
 select * into d from public.funnel_journey_definition_drafts where funnel_id=f for update;
 if not found or d.revision<>r then raise exception 'Journey draft changed; reload before publishing' using errcode='40001';end if;
 perform kma_internal.validate_funnel_journey_definition(d.definition);
 select coalesce(max(version),0)+1 into v from public.funnel_journey_definition_versions where funnel_id=f;
 update public.funnel_journey_definition_versions set archived_at=ts where funnel_id=f and archived_at is null;
 insert into public.funnel_journey_definition_versions(funnel_id,version,template,definition,published_at,published_by) values(f,v,d.template,d.definition,ts,auth.uid());
 update public.funnel_journey_definition_drafts set revision=revision+1,updated_at=ts,updated_by=auth.uid() where funnel_id=f;
 return public.get_admin_funnel_journey_definition(f);
end;$$;

create or replace function public.ingest_funnel_metric_event(p_product_id uuid,p_funnel_id uuid,p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
 if not coalesce(exists(select 1 from jsonb_array_elements(defs) m where m->>'event_name'=p_event->>'event_name'),false) and not exists(select 1 from public.funnel_journey_definition_versions v cross join lateral jsonb_array_elements(v.definition->'stages') s where v.funnel_id=p_funnel_id and s->>'source'='event' and s->'event_names' ? (p_event->>'event_name')) then raise exception 'Unknown journey event; publish a journey stage or custom metric definition first' using errcode='22023';end if;
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

-- Evaluate saved rules over the same click cohort and verified identity graph as
-- commerce reporting. A version selects calculation rules, not a new event log.
-- All paths count distinct people; paths can overlap and do not allocate orders.
create function kma_internal.configured_funnel_journey_report(p_definition jsonb,p_product uuid,p_funnel uuid,p_affiliate uuid,p_link uuid,p_start timestamptz,p_end timestamptz,p_environment text,p_days integer,p_currency text,p_filters jsonb)
returns jsonb language sql stable security definer set search_path='' as $$
with recursive clicks as materialized (
 select c.* from public.clicks c join public.funnel_journey_clicks j on j.click_record_id=c.id and j.environment=p_environment
 where c.product_id=p_product and c.funnel_id=p_funnel and (p_affiliate is null or c.affiliate_id=p_affiliate) and (p_link is null or c.affiliate_link_id=p_link)
 and not c.is_bot and c.occurred_at>=p_start and c.occurred_at<p_end and c.occurred_at<=statement_timestamp()
), raw_events as materialized (
 select e.*,i.canonical_subject_id person from public.funnel_metric_events e join clicks c on c.id=e.click_record_id
 join public.funnel_journey_identities i on i.product_id=e.product_id and i.funnel_id=e.funnel_id and i.environment=e.journey_environment and i.subject_id=e.subject_id and i.click_record_id=e.click_record_id
 where e.product_id=p_product and e.funnel_id=p_funnel and e.journey_environment=p_environment
 and e.occurred_at>=c.occurred_at-interval '5 minutes' and e.occurred_at<=least(statement_timestamp(),c.occurred_at+make_interval(days=>p_days))
), eligible_people as (
 select distinct person from raw_events where p_filters='{}' or evidence @> p_filters
), events as materialized (
 select e.* from raw_events e join eligible_people p using(person)
), orders as materialized (
 select o.id,purchase.provider_occurred_at occurred_at,coalesce(identity.canonical_subject_id,known.subject_id) person
 from public.external_commerce_orders o join clicks c on c.id=o.click_record_id
 join public.external_commerce_events purchase on purchase.order_id=o.id and purchase.kind='purchase'
 left join lateral (
 select ei.subject_id,1 priority from public.external_order_eligibility_identity ei where ei.order_id=o.id
 union all select e.subject_id,2 priority from events e where e.evidence->>'order_id'=o.external_order_id::text and e.click_record_id=o.click_record_id
 union all select m.learner_id,3 priority from public.managed_checkout_orders m where m.external_order_id=o.external_order_id and m.product_id=o.product_id and m.funnel_id=o.funnel_id and m.account_id=o.stripe_account_id and m.livemode=o.livemode
 order by priority,subject_id limit 1
 ) known on true
 left join public.funnel_journey_identities identity on identity.product_id=o.product_id and identity.funnel_id=o.funnel_id and identity.environment=p_environment and identity.subject_id=known.subject_id and identity.click_record_id=o.click_record_id
 where o.product_id=p_product and o.funnel_id=p_funnel and o.livemode=(p_environment='live') and (p_currency is null or o.currency=p_currency)
 and purchase.provider_occurred_at>=c.occurred_at and purchase.provider_occurred_at<=least(statement_timestamp(),c.occurred_at+make_interval(days=>p_days))
 and (p_filters='{}' or exists(select 1 from eligible_people p where p.person=coalesce(identity.canonical_subject_id,known.subject_id)))
 and (not(p_filters?'intake_id') or exists(select 1 from public.external_order_eligibility_identity ei where ei.order_id=o.id and ei.dimensions->>'intake_id'=p_filters->>'intake_id')
 or exists(select 1 from public.managed_checkout_orders m where m.external_order_id=o.external_order_id and m.account_id=o.stripe_account_id and m.livemode=o.livemode and m.context->>'intake_id'=p_filters->>'intake_id')
 or exists(select 1 from events e where e.click_record_id=o.click_record_id and e.evidence->>'order_id'=o.external_order_id::text and e.evidence->>'intake_id'=p_filters->>'intake_id'))
), stages as materialized (
 select value stage,n ordinal from jsonb_array_elements(coalesce(p_definition->'stages','[]')) with ordinality s(value,n)
), candidate_events as materialized (
 select s.stage,e.person,e.occurred_at,e.state_value,e.evidence,e.received_at,e.external_event_id,
 s.stage->>'context_field' context_field,e.evidence->>(s.stage->>'context_field') context_value,
 row_number() over(partition by s.stage->>'key',e.person,coalesce(e.evidence->>coalesce(s.stage->>'context_field','context_id'),'') order by coalesce((e.evidence->>'state_revision')::integer,0) desc,e.occurred_at desc,e.received_at desc,e.external_event_id desc) state_rank
 from stages s join events e on s.stage->>'source'='event' and s.stage->'event_names' ? e.event_name
), facts as materialized (
 select stage->>'key' stage_key,person,occurred_at,context_field,context_value from candidate_events
 where (not(stage?'state_value') or (state_rank=1 and state_value=stage->>'state_value'))
 and (context_field is null or coalesce(context_value,'')<>'')
 -- Resolve state before filtering dimensions: old states must not reappear.
 and (not(stage?'state_value') or evidence @> p_filters)
 and (context_field is null or not(p_filters?context_field) or context_value=p_filters->>context_field)
 union all
 select s.stage->>'key',o.person,o.occurred_at,null::text,null::text from stages s cross join orders o where s.stage->>'source'='purchase' and o.person is not null
), sequences as materialized (
 select 'rate' kind,value item,n ordinal from jsonb_array_elements(coalesce(p_definition->'rates','[]')) with ordinality r(value,n)
 union all
 select 'path' kind,value item,n ordinal from jsonb_array_elements(coalesce(p_definition->'paths','[]')) with ordinality r(value,n)
), walk(kind,key,position,person,occurred_at,contexts) as (
 select s.kind,s.item->>'key',1,f.person,min(f.occurred_at),case when f.context_field is null then '{}'::jsonb else jsonb_build_object(f.context_field,f.context_value) end
 from sequences s join facts f on f.stage_key=s.item#>>'{steps,0}'
 group by s.kind,s.item->>'key',f.person,f.context_field,f.context_value
 union
 select w.kind,w.key,w.position+1,w.person,f.occurred_at,
 w.contexts||case when f.context_field is null then '{}'::jsonb else jsonb_build_object(f.context_field,f.context_value) end
 from walk w join sequences s on s.kind=w.kind and s.item->>'key'=w.key
 join lateral (
 select min(next_fact.occurred_at) occurred_at,next_fact.context_field,next_fact.context_value from facts next_fact
 where next_fact.person=w.person and next_fact.stage_key=s.item->'steps'->>w.position and next_fact.occurred_at>=w.occurred_at
 and (next_fact.context_field is null or not(w.contexts?next_fact.context_field) or w.contexts->>next_fact.context_field=next_fact.context_value)
 group by next_fact.context_field,next_fact.context_value
 ) f on true
 where w.position<jsonb_array_length(s.item->'steps')
), sequence_counts as (
 select s.*, (select count(distinct f.person) from facts f where f.stage_key=s.item#>>'{steps,0}') denominator,
 (select count(distinct w.person) from walk w where w.kind=s.kind and w.key=s.item->>'key' and w.position=jsonb_array_length(s.item->'steps')) numerator from sequences s
)
select jsonb_build_object(
 'configured_stages',coalesce((select jsonb_agg(jsonb_build_object('key',s.stage->>'key','label',s.stage->>'label','people',(select count(distinct person) from facts f where f.stage_key=s.stage->>'key')) order by s.ordinal) from stages s),'[]'),
 'configured_rates',coalesce((select jsonb_agg(jsonb_build_object('key',s.item->>'key','label',s.item->>'label','numerator',s.numerator,'denominator',s.denominator,'value',round(s.numerator*100.0/nullif(s.denominator,0),2),'status',case when s.denominator=0 then 'zero_denominator' else 'available' end) order by s.ordinal) from sequence_counts s where kind='rate'),'[]'),
 'configured_paths',coalesce((select jsonb_agg(jsonb_build_object('key',s.item->>'key','label',s.item->>'label','people',s.numerator) order by s.ordinal) from sequence_counts s where kind='path'),'[]')
);
$$;

create or replace function public.funnel_metrics_report(p_input jsonb,p_admin boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb; env text; days integer; currency text; affiliate uuid; filters jsonb; starts timestamptz; ends timestamptz; journey jsonb; definition public.funnel_journey_definition_versions; requested_version integer;
begin
 -- Preserve the existing authorization, product/funnel ownership, creator self
 -- scope, dates, dimensions, custom card version and immutable commerce checks.
 base:=public.funnel_metrics_report_v1(p_input-array['conversion_window_days','currency','journey_version'],p_admin);
 env:=coalesce(p_input->>'environment','live');days:=coalesce((p_input->>'conversion_window_days')::integer,(select conversion_window_days from public.funnel_journey_configuration where funnel_id=(p_input->>'funnel_id')::uuid),30);currency:=p_input->>'currency';
 if env not in('test','live') or days not between 1 and 365 or (currency is not null and currency!~'^[A-Z]{3}$') then raise exception 'Invalid journey report scope' using errcode='22023';end if;
 if p_input?'journey_version' then
 if jsonb_typeof(p_input->'journey_version') is distinct from 'number' or (p_input->>'journey_version')!~'^[1-9][0-9]{0,8}$' then raise exception 'Choose a positive published journey version' using errcode='22023';end if;
 requested_version:=(p_input->>'journey_version')::integer;
 end if;
 select * into definition from public.funnel_journey_definition_versions where funnel_id=(p_input->>'funnel_id')::uuid and (requested_version is null or version=requested_version) order by version desc limit 1;
 if requested_version is not null and definition.version is null then raise exception 'Published journey version not found for this funnel' using errcode='P0002';end if;
 affiliate:=case when p_admin then nullif(p_input->>'affiliate_id','')::uuid else public.current_partner_affiliate_id(false) end;
 starts:=(p_input->>'date_from')::date::timestamp at time zone coalesce(p_input->>'time_zone','UTC');ends:=((p_input->>'date_to')::date+1)::timestamp at time zone coalesce(p_input->>'time_zone','UTC');
 filters:=p_input-array['product_id','funnel_id','date_from','date_to','time_zone','link_id','version','journey_version','affiliate_id','environment','conversion_window_days','currency'];
 journey:=kma_internal.funnel_journey_report((p_input->>'product_id')::uuid,(p_input->>'funnel_id')::uuid,affiliate,nullif(p_input->>'link_id','')::uuid,starts,ends,env,days,currency,filters);
 journey:=journey||kma_internal.configured_funnel_journey_report(definition.definition,(p_input->>'product_id')::uuid,(p_input->>'funnel_id')::uuid,affiliate,nullif(p_input->>'link_id','')::uuid,starts,ends,env,days,currency,filters)
 ||jsonb_build_object('definition_version',definition.version,'definition_template',definition.template,'definition_published_at',definition.published_at,'definition_effective_until',definition.archived_at,
 'warnings',jsonb_build_array(
 'Journey rules use the selected published definition over the same valid creator-click cohort and reporting window. This window does not change signed commission attribution terms.',
 'Stages, ordered conversions and paths count distinct people. Paths can overlap; they do not allocate purchase credit or add up to an exclusive order total.',
 'State stages use the latest reported state for each person and context. Missing evidence does not imply any particular state.',
 'Recent cohorts may still convert. Historical clicks without an explicit environment are excluded, never assumed to be live.',
 'Approved earnings include amounts already transferred. Transfers are a subset of earnings, not additional earnings, and do not prove a bank payout.',
 'Purchases and successful refunds come only from verified commerce records. Refunds adjust their original orders even after the conversion window.',
 'Pending and unconfigured commission is not approved income. Latest traffic and email sources never replace the credited creator.',
 'Changing a published definition changes the selected calculation rules, not stored events. Select an earlier definition version to reproduce its rules.'
 ));
 if p_input?'environment' or p_input?'currency' then base:=jsonb_set(base,'{commerce,currencies}',coalesce((select jsonb_agg(x) from jsonb_array_elements(base#>'{commerce,currencies}') x where (not(p_input?'environment') or (x->>'livemode')::boolean=(env='live')) and (currency is null or x->>'currency'=currency)),'[]'));end if;
 return base||jsonb_build_object('journey',journey);
end;$$;

-- Preserve only explicitly configured webinar funnels. A generic funnel does not
-- acquire webinar semantics merely because it already has tracking enabled.
create function kma_internal.import_existing_webinar_journey_definitions()
returns integer language plpgsql security definer set search_path='' as $$
declare inserted integer; webinar jsonb := $definition${"stages":[{"key":"visitors","label":"Landing visitors","source":"event","event_names":["landing_page_viewed"]},{"key":"leads","label":"Email leads","source":"event","event_names":["lead_created","email_lead"]},{"key":"verified","label":"Verified people","source":"event","event_names":["email_verified"]},{"key":"checkout_started","label":"Checkout started","source":"event","event_names":["checkout_created","checkout_opened"]},{"key":"cancelled_checkout","label":"Returned from cancelled checkout","source":"event","event_names":["checkout_cancel_returned"]},{"key":"paid","label":"Paying people","source":"purchase"},{"key":"assessment_started","label":"Assessment started","source":"event","event_names":["assessment_started"],"context_field":"assessment_attempt_id"},{"key":"assessment_completed","label":"Assessment completed","source":"event","event_names":["assessment_completed"],"context_field":"assessment_attempt_id"},{"key":"availability_saved","label":"Availability saved","source":"event","event_names":["availability_saved"]},{"key":"invitation_requested","label":"Webinar invitation requested","source":"event","event_names":["webinar_invitation_requested","webinar_requested"]},{"key":"registered","label":"Webinar registrations","source":"event","event_names":["webinar_registered"],"context_field":"webinar_id"},{"key":"attended","label":"Confirmed webinar attendees","source":"event","event_names":["webinar_attendance_updated","webinar_attendance"],"state_value":"attended","context_field":"webinar_id"},{"key":"attendance_unknown","label":"Reported attendance unknown","source":"event","event_names":["webinar_attendance_updated","webinar_attendance"],"state_value":"unknown","context_field":"webinar_id"},{"key":"attendance_missed","label":"Confirmed no-shows","source":"event","event_names":["webinar_attendance_updated","webinar_attendance"],"state_value":"missed","context_field":"webinar_id"},{"key":"resources","label":"Resource engagement","source":"event","event_names":["resource_opened","resource_accessed","resource_served"]},{"key":"matching_pool","label":"Matching pool joined","source":"event","event_names":["matching_pool_entered"],"context_field":"intake_id"},{"key":"group_confirmed","label":"Group confirmed","source":"event","event_names":["group_confirmed"],"context_field":"intake_id"}],"rates":[{"key":"landing_to_signup","label":"Landing page → email signup","steps":["visitors","leads"]},{"key":"signup_to_purchase","label":"Email signup → purchase","steps":["leads","paid"]},{"key":"checkout_to_purchase","label":"Checkout → purchase","steps":["checkout_started","paid"]},{"key":"signup_to_registration","label":"Email signup → webinar registration","steps":["leads","registered"]},{"key":"registration_to_attendance","label":"Webinar registration → attendance","steps":["registered","attended"]},{"key":"assessment_completion","label":"Assessment completion","steps":["assessment_started","assessment_completed"]},{"key":"resource_engagement","label":"Email signup → resource engagement","steps":["leads","resources"]},{"key":"webinar_to_purchase","label":"Webinar attendance → purchase","steps":["attended","paid"]},{"key":"cancelled_to_invitation","label":"Cancelled checkout → webinar invitation","steps":["cancelled_checkout","invitation_requested"]}],"paths":[{"key":"assessment_payment","label":"Assessment → payment","steps":["assessment_completed","paid"]},{"key":"webinar_assessment_payment","label":"Webinar → assessment → payment","steps":["attended","assessment_completed","paid"]},{"key":"webinar_payment","label":"Webinar → payment","steps":["attended","paid"]},{"key":"cancelled_webinar_payment","label":"Cancelled checkout → invitation → registration → attendance → payment","steps":["cancelled_checkout","invitation_requested","registered","attended","paid"]},{"key":"paid_matching","label":"Payment → matching pool → group confirmed","steps":["paid","matching_pool","group_confirmed"]}]}$definition$::jsonb;
begin
 insert into public.funnel_journey_definition_versions(funnel_id,version,template,definition,published_at)
 select c.funnel_id,1,'webinar',webinar,clock_timestamp() from public.funnel_journey_configuration c
 join public.funnel_metric_versions m on m.funnel_id=c.funnel_id and m.archived_at is null and m.template='webinar'
 where not exists(select 1 from public.funnel_journey_definition_versions v where v.funnel_id=c.funnel_id)
 and not exists(select 1 from public.funnel_journey_definition_drafts d where d.funnel_id=c.funnel_id)
 on conflict do nothing;
 get diagnostics inserted=row_count;
 insert into public.funnel_journey_definition_drafts(funnel_id,revision,template,definition)
 select v.funnel_id,1,v.template,v.definition from public.funnel_journey_definition_versions v where v.version=1 and v.template='webinar'
 on conflict do nothing;
 return inserted;
end;$$;
select kma_internal.import_existing_webinar_journey_definitions();

revoke all on function kma_internal.validate_funnel_journey_definition(jsonb),kma_internal.import_existing_webinar_journey_definitions(),kma_internal.configured_funnel_journey_report(jsonb,uuid,uuid,uuid,uuid,timestamptz,timestamptz,text,integer,text,jsonb),public.get_admin_funnel_journey_definition(uuid),public.save_admin_funnel_journey_definition(jsonb),public.publish_admin_funnel_journey_definition(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_admin_funnel_journey_definition(uuid),public.save_admin_funnel_journey_definition(jsonb),public.publish_admin_funnel_journey_definition(jsonb) to authenticated;
-- Existing ingress remains service-only. Private evaluators are never browser RPCs.
revoke all on function public.ingest_funnel_metric_event(uuid,uuid,jsonb),public.funnel_metrics_report(jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.ingest_funnel_metric_event(uuid,uuid,jsonb) to service_role;
commit;
