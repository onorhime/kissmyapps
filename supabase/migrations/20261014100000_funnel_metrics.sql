-- Generic funnel measurement is separate from the canonical financial ledger.
-- Published definitions have bounded effective intervals; neither definitions
-- nor events can rewrite past published semantics. Only trusted servers ingest.
begin;
create table public.funnel_metric_drafts (
 funnel_id uuid primary key references public.funnels(id), revision integer not null default 0,
 template text not null default 'blank', metrics jsonb not null default '[]', updated_at timestamptz not null default now()
);
create table public.funnel_metric_versions (
 funnel_id uuid not null references public.funnels(id), version integer not null,
 template text not null, metrics jsonb not null, published_at timestamptz not null,
 archived_at timestamptz, primary key(funnel_id,version), check(archived_at is null or archived_at>=published_at)
);
create unique index funnel_metric_active_version on public.funnel_metric_versions(funnel_id) where archived_at is null;
create table public.funnel_metric_events (
 id uuid primary key default gen_random_uuid(), external_event_id uuid not null,
 product_id uuid not null references public.products(id), funnel_id uuid not null references public.funnels(id),
 affiliate_id uuid not null references public.affiliates(id), link_id uuid not null references public.affiliate_links(id),
 click_record_id uuid not null references public.clicks(id), acquisition_id uuid not null references public.acquisitions(id),
 event_name text not null, subject_id text not null, context_id text, session_id text, state_value text,
 occurred_at timestamptz not null, presence_expires_at timestamptz, received_at timestamptz not null default clock_timestamp(),
 evidence jsonb not null, unique(product_id,funnel_id,external_event_id)
);
create index funnel_metric_scope_time on public.funnel_metric_events(funnel_id,affiliate_id,event_name,occurred_at desc);
create index funnel_metric_state_time on public.funnel_metric_events(funnel_id,event_name,subject_id,context_id,occurred_at desc);
alter table public.funnel_metric_drafts enable row level security;
alter table public.funnel_metric_versions enable row level security;
alter table public.funnel_metric_events enable row level security;
revoke all on public.funnel_metric_drafts,public.funnel_metric_versions,public.funnel_metric_events from public,anon,authenticated;
grant select on public.funnel_metric_drafts,public.funnel_metric_versions,public.funnel_metric_events to service_role;
create trigger funnel_metric_event_immutable before update or delete on public.funnel_metric_events for each row execute function kma_internal.external_commerce_immutable();
create function public.guard_funnel_metric_version() returns trigger language plpgsql set search_path='' as $$begin
 if tg_op='DELETE' or (to_jsonb(new)-'archived_at') is distinct from (to_jsonb(old)-'archived_at') or old.archived_at is not null or new.archived_at is null then
 raise exception 'published metric definitions are immutable' using errcode='22023'; end if; return new; end;$$;
create trigger funnel_metric_version_immutable before update or delete on public.funnel_metric_versions for each row execute function public.guard_funnel_metric_version();

create function public.validate_funnel_metric_definitions(p_metrics jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare m jsonb; seen text[]:='{}'; count_keys text[]:='{}'; k text; t text;
begin
 if jsonb_typeof(p_metrics) is distinct from 'array' or jsonb_array_length(p_metrics)>24 then raise exception 'Provide an array of at most 24 metrics' using errcode='22023'; end if;
 for m in select value from jsonb_array_elements(p_metrics) loop
 k:=m->>'key'; t:=m->>'type';
 if jsonb_typeof(m)<>'object' or exists(select 1 from jsonb_object_keys(m) x where x<>all(array['key','label','type','event_name','state_value','numerator_key','denominator_key','visible']))
 or exists(select 1 from jsonb_each(m) x where x.key<>'visible' and jsonb_typeof(x.value)<>'string') or k is null or k!~'^[a-z][a-z0-9_]{0,49}$' or k=any(seen) or (coalesce(length(btrim(m->>'label')),0)<1 or length(m->>'label')>80)
 or (m ? 'visible' and jsonb_typeof(m->'visible')<>'boolean') or t is null or t<>all(array['event_count','unique_people','unique_per_context','current_state','live_presence','ratio']) then raise exception 'Invalid or duplicate metric definition' using errcode='22023'; end if;
 if t='ratio' then
 if not(coalesce(m->>'numerator_key','')=any(count_keys)) or not(coalesce(m->>'denominator_key','')=any(count_keys)) or m ?| array['event_name','state_value'] then raise exception 'Ratios must reference preceding count metrics; formulas are not accepted' using errcode='22023'; end if;
 else
 if coalesce(m->>'event_name','')!~'^[a-z][a-z0-9_]{0,79}$' or m ?| array['numerator_key','denominator_key'] then raise exception 'A count metric requires an event name' using errcode='22023'; end if;
 if t='current_state' and coalesce(m->>'state_value','')!~'^[a-z][a-z0-9_]{0,49}$' then raise exception 'Current state requires a state value' using errcode='22023'; end if;
 if t<>'current_state' and m ? 'state_value' then raise exception 'State filter only applies to current state metrics' using errcode='22023'; end if;
 count_keys:=array_append(count_keys,k);
 end if;
 seen:=array_append(seen,k);
 end loop; return true;
end;$$;

create function public.get_admin_funnel_metrics_config(p_funnel_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p uuid; d jsonb; v jsonb;
begin
 if not public.current_user_is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
 select product_id into p from public.funnels where id=p_funnel_id; if p is null then raise exception 'Funnel not found' using errcode='P0002'; end if;
 select jsonb_build_object('revision',revision,'template',template,'metrics',metrics) into d from public.funnel_metric_drafts where funnel_id=p_funnel_id;
 select coalesce(jsonb_agg(jsonb_build_object('version',version,'published_at',published_at,'archived_at',archived_at,'template',template,'metrics',metrics) order by version desc),'[]') into v from public.funnel_metric_versions where funnel_id=p_funnel_id;
 return jsonb_build_object('product_id',p,'funnel_id',p_funnel_id,'draft',coalesce(d,'{"revision":0,"template":"blank","metrics":[]}'::jsonb),'versions',v);
end;$$;
create function public.save_admin_funnel_metrics_draft(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare f uuid; r integer; t text; stored integer;
begin
 if not public.current_user_is_admin(array['owner','operations']) then raise exception 'Metric editing requires owner or operations access' using errcode='42501'; end if;
 if jsonb_typeof(p_input)<>'object' or exists(select 1 from jsonb_object_keys(p_input) x where x<>all(array['funnel_id','expected_revision','metrics','template'])) then raise exception 'Invalid draft input' using errcode='22023'; end if;
 f:=(p_input->>'funnel_id')::uuid; r:=(p_input->>'expected_revision')::integer; t:=coalesce(p_input->>'template','blank');
 if f is null or r is null or r<0 or t!~'^[a-z][a-z0-9_-]{0,49}$' then raise exception 'Invalid draft identity' using errcode='22023'; end if;
 perform public.validate_funnel_metric_definitions(p_input->'metrics');
 perform pg_advisory_xact_lock(hashtextextended('funnel-metrics:'||f::text,0));
 insert into public.funnel_metric_drafts(funnel_id) values(f) on conflict do nothing;
 select revision into stored from public.funnel_metric_drafts where funnel_id=f for update;
 if stored<>r then raise exception 'The draft changed; reload before saving' using errcode='40001'; end if;
 update public.funnel_metric_drafts set revision=revision+1,template=t,metrics=p_input->'metrics',updated_at=clock_timestamp() where funnel_id=f;
 return public.get_admin_funnel_metrics_config(f);
end;$$;
create function public.publish_admin_funnel_metrics(p_funnel_id uuid,p_expected_revision integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.funnel_metric_drafts; v integer; ts timestamptz:=clock_timestamp();
begin
 if not public.current_user_is_admin(array['owner','operations']) then raise exception 'Publishing requires owner or operations access' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('funnel-metrics:'||p_funnel_id::text,0));
 select * into d from public.funnel_metric_drafts where funnel_id=p_funnel_id for update;
 if not found or p_expected_revision is null or d.revision<>p_expected_revision then raise exception 'The draft changed; reload before publishing' using errcode='40001'; end if;
 perform public.validate_funnel_metric_definitions(d.metrics);
 if jsonb_array_length(d.metrics)=0 then raise exception 'Add at least one metric before publishing' using errcode='22023'; end if;
 select coalesce(max(version),0)+1 into v from public.funnel_metric_versions where funnel_id=p_funnel_id;
 update public.funnel_metric_versions set archived_at=ts where funnel_id=p_funnel_id and archived_at is null;
 insert into public.funnel_metric_versions values(p_funnel_id,v,d.template,d.metrics,ts,null);
 update public.funnel_metric_drafts set revision=revision+1,updated_at=ts where funnel_id=p_funnel_id;
 return public.get_admin_funnel_metrics_config(p_funnel_id);
end;$$;

create function public.validate_funnel_metric_event(p_event jsonb,p_sample boolean default false) returns boolean language plpgsql stable set search_path='' as $$
declare ts timestamptz; expiry timestamptz; k text;
begin
 if jsonb_typeof(p_event) is distinct from 'object' or pg_column_size(p_event)>8192 or exists(select 1 from jsonb_each(p_event) x where jsonb_typeof(x.value)<>'string') or exists(select 1 from jsonb_object_keys(p_event) x where x<>all(array['event_id','event_name','click_id','subject_id','occurred_at','context_id','session_id','state_value','presence_expires_at'])) then raise exception 'Unsupported metric event fields' using errcode='22023'; end if;
 if not p_sample and (coalesce(p_event->>'event_id','')!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or coalesce(p_event->>'click_id','')!~'^[A-Za-z0-9_-]{16,128}$') then raise exception 'Event ID and valid acquisition click are required' using errcode='22023'; end if;
 if coalesce(p_event->>'subject_id','')!~'^[A-Za-z0-9_-]{16,128}$' or coalesce(p_event->>'event_name','')!~'^[a-z][a-z0-9_]{0,79}$' then raise exception 'An opaque product subject and event name are required' using errcode='22023'; end if;
 foreach k in array array['context_id','session_id'] loop if p_event ? k and coalesce(p_event->>k,'')!~'^[A-Za-z0-9_-]{1,128}$' then raise exception 'Invalid opaque context or session' using errcode='22023'; end if; end loop;
 if p_event ? 'state_value' and coalesce(p_event->>'state_value','')!~'^[a-z][a-z0-9_]{0,49}$' then raise exception 'Invalid state' using errcode='22023'; end if;
 if coalesce(p_event->>'occurred_at','')!~'^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then raise exception 'A finite ISO timestamp with timezone is required' using errcode='22023'; end if;
 ts:=(p_event->>'occurred_at')::timestamptz;
 if not isfinite(ts) or ts>clock_timestamp()+interval '5 minutes' then raise exception 'Event timestamp is invalid or in the future' using errcode='22023'; end if;
 if p_event ? 'presence_expires_at' then
 if coalesce(p_event->>'presence_expires_at','')!~'^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then raise exception 'Presence expiry must be ISO with timezone' using errcode='22023'; end if;
 expiry:=(p_event->>'presence_expires_at')::timestamptz;
 if expiry is null or not isfinite(expiry) or expiry<ts or expiry>ts+interval '300 seconds' or not(p_event ?& array['context_id','session_id','state_value']) or p_event->>'state_value'<>all(array['active','left']) then raise exception 'Presence requires a context, session, active/left state, and expiry within 300 seconds' using errcode='22023'; end if;
 end if; return true;
end;$$;
create function public.validate_admin_funnel_metric_event(p_input jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.current_user_is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
 if not exists(select 1 from public.funnels where id=(p_input->>'funnel_id')::uuid) then raise exception 'Funnel not found' using errcode='P0002'; end if;
 begin perform public.validate_funnel_metric_event(p_input->'event'); return '{"valid":true,"errors":[]}'::jsonb;
 exception when others then return jsonb_build_object('valid',false,'errors',jsonb_build_array(sqlerrm)); end;
end;$$;
create function public.ingest_funnel_metric_event(p_product_id uuid,p_funnel_id uuid,p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.clicks; a public.acquisitions; prior public.funnel_metric_events; identity uuid; defs jsonb;
begin
 perform public.validate_funnel_metric_event(p_event);
 perform public.assert_funnel_request_scope('metric-ingress',p_event->>'click_id',p_product_id,p_funnel_id);
 select * into c from public.clicks where public_click_id=p_event->>'click_id';
 select * into a from public.acquisitions where click_record_id=c.id and product_id=p_product_id and funnel_id=p_funnel_id and status in('open','resolved') order by created_at,id limit 1;
 if c.affiliate_id is distinct from a.affiliate_id then raise exception 'Acquisition creator mismatch' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_product_id::text||p_funnel_id::text||(p_event->>'event_id'),0));
 select * into prior from public.funnel_metric_events where product_id=p_product_id and funnel_id=p_funnel_id and external_event_id=(p_event->>'event_id')::uuid;
 if found then if prior.evidence<>p_event then raise exception 'Event ID already contains different evidence' using errcode='23505'; end if; return jsonb_build_object('event_id',prior.id,'duplicate',true); end if;
 select metrics into defs from public.funnel_metric_versions where funnel_id=p_funnel_id and published_at<=(p_event->>'occurred_at')::timestamptz and (archived_at is null or (p_event->>'occurred_at')::timestamptz<archived_at) order by version desc limit 1;
 if defs is null then select metrics into defs from public.funnel_metric_versions where funnel_id=p_funnel_id and archived_at is null; end if;
 if defs is null or not exists(select 1 from jsonb_array_elements(defs) m where m->>'event_name'=p_event->>'event_name') then raise exception 'Publish a definition for this event before connecting it' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(defs) m where m->>'event_name'=p_event->>'event_name' and ((m->>'type'='unique_per_context' and not(p_event ? 'context_id')) or (m->>'type'='current_state' and not(p_event ? 'state_value')) or (m->>'type'='live_presence' and not(p_event ? 'presence_expires_at')))) then raise exception 'Event is missing context, state, or expiry required by its definitions' using errcode='22023'; end if;
 insert into public.funnel_metric_events(external_event_id,product_id,funnel_id,affiliate_id,link_id,click_record_id,acquisition_id,event_name,subject_id,context_id,session_id,state_value,occurred_at,presence_expires_at,evidence)
 values((p_event->>'event_id')::uuid,p_product_id,p_funnel_id,c.affiliate_id,c.affiliate_link_id,c.id,a.id,p_event->>'event_name',p_event->>'subject_id',p_event->>'context_id',p_event->>'session_id',p_event->>'state_value',(p_event->>'occurred_at')::timestamptz,(p_event->>'presence_expires_at')::timestamptz,p_event) returning id into identity;
 return jsonb_build_object('event_id',identity,'duplicate',false);
end;$$;

-- Shared evaluator reads an indexed scoped relation. Sample rows are a separate
-- source with no persistent writes and never mixed with production events.
create function public.funnel_metric_rows(p_product uuid,p_funnel uuid,p_affiliate uuid,p_link uuid,p_effective_from timestamptz,p_effective_until timestamptz,p_samples jsonb)
returns table(event_name text,subject_id text,context_id text,session_id text,state_value text,occurred_at timestamptz,presence_expires_at timestamptz,received_at timestamptz,tie_break text)
language sql stable security definer set search_path='' as $$
 select e.event_name,e.subject_id,e.context_id,e.session_id,e.state_value,e.occurred_at,e.presence_expires_at,e.received_at,e.external_event_id::text
 from public.funnel_metric_events e where p_samples is null and e.product_id=p_product and e.funnel_id=p_funnel and (p_affiliate is null or e.affiliate_id=p_affiliate) and (p_link is null or e.link_id=p_link) and e.occurred_at>=p_effective_from and (p_effective_until is null or e.occurred_at<p_effective_until)
 union all
 select x->>'event_name',x->>'subject_id',x->>'context_id',x->>'session_id',x->>'state_value',(x->>'occurred_at')::timestamptz,(x->>'presence_expires_at')::timestamptz,(x->>'occurred_at')::timestamptz,coalesce(x->>'event_id',lpad(n::text,12,'0'))
 from jsonb_array_elements(coalesce(p_samples,'[]')) with ordinality as s(x,n) where p_samples is not null;
$$;
create function public.compute_funnel_metrics(p_metrics jsonb,p_product uuid,p_funnel uuid,p_affiliate uuid,p_link uuid,p_start timestamptz,p_end timestamptz,p_effective_from timestamptz,p_effective_until timestamptz,p_asof timestamptz,p_samples jsonb default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m jsonb; result jsonb:='[]'; vals jsonb:='{}'; n numeric; numerator numeric; denominator numeric; seen timestamptz; availability text; t text;
begin
 for m in select value from jsonb_array_elements(p_metrics) loop
 n:=null; seen:=null; availability:='available'; t:=m->>'type';
 if t='ratio' then
 numerator:=(vals->(m->>'numerator_key')->>'value')::numeric; denominator:=(vals->(m->>'denominator_key')->>'value')::numeric;
 if numerator is null or denominator is null then availability:='awaiting_data'; elsif denominator=0 then availability:='zero_denominator'; else n:=round(100*numerator/denominator,2); end if;
 else
 select max(r.received_at) into seen from public.funnel_metric_rows(p_product,p_funnel,p_affiliate,p_link,p_effective_from,p_effective_until,p_samples) r where r.event_name=m->>'event_name';
 if seen is null and p_samples is null then availability:='awaiting_data'; else
 if t='current_state' then
 select count(*) into n from (select distinct on(r.subject_id,coalesce(r.context_id,'')) r.state_value from public.funnel_metric_rows(p_product,p_funnel,p_affiliate,p_link,p_effective_from,p_effective_until,p_samples) r where r.event_name=m->>'event_name' and r.occurred_at<=p_asof order by r.subject_id,coalesce(r.context_id,''),r.occurred_at desc,r.tie_break desc) latest where latest.state_value=m->>'state_value';
 elsif t='live_presence' then
 select count(distinct (latest.subject_id,latest.context_id)) into n from (select distinct on(r.subject_id,r.context_id,r.session_id) r.subject_id,r.context_id,r.state_value,r.presence_expires_at from public.funnel_metric_rows(p_product,p_funnel,p_affiliate,p_link,p_effective_from,p_effective_until,p_samples) r where r.event_name=m->>'event_name' and r.occurred_at<=p_asof order by r.subject_id,r.context_id,r.session_id,r.occurred_at desc,r.tie_break desc) latest where latest.state_value='active' and latest.presence_expires_at>p_asof;
 else
 select case t when 'event_count' then count(*) when 'unique_people' then count(distinct r.subject_id) when 'unique_per_context' then count(distinct (r.subject_id,r.context_id)) filter(where r.context_id is not null) end into n from public.funnel_metric_rows(p_product,p_funnel,p_affiliate,p_link,p_effective_from,p_effective_until,p_samples) r where r.event_name=m->>'event_name' and r.occurred_at>=p_start and r.occurred_at<p_end and r.occurred_at<=p_asof;
 end if;
 end if;
 end if;
 vals:=vals||jsonb_build_object(m->>'key',jsonb_build_object('value',n));
 result:=result||jsonb_build_array(jsonb_build_object('key',m->>'key','label',m->>'label','type',t,'visible',coalesce((m->>'visible')::boolean,true),'value',n,'availability',availability,'last_received_at',seen));
 end loop; return result;
end;$$;

create function public.funnel_metrics_report(p_input jsonb,p_admin boolean) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare product uuid; funnel uuid; affiliate uuid; link uuid; dfrom date; dto date; tz text; starts timestamptz; ends timestamptz; asof timestamptz; v public.funnel_metric_versions; values_json jsonb; latest timestamptz; commerce jsonb; commerce_latest timestamptz; commerce_connected boolean; currencies jsonb;
begin
 if p_admin then if not public.current_user_is_admin() then raise exception 'Admin access required' using errcode='42501'; end if; affiliate:=nullif(p_input->>'affiliate_id','')::uuid;
 else affiliate:=public.current_partner_affiliate_id(false); if p_input ? 'affiliate_id' then raise exception 'Creator reports are self scoped' using errcode='42501'; end if; end if;
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) x where x<>all(array['product_id','funnel_id','date_from','date_to','time_zone','link_id','version','affiliate_id'])) then raise exception 'Invalid report filters' using errcode='22023'; end if;
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
 values_json:=coalesce(public.compute_funnel_metrics(coalesce(v.metrics,'[]'),product,funnel,affiliate,link,starts,ends,v.published_at,v.archived_at,least(asof,coalesce(v.archived_at-interval '1 microsecond',asof))),'[]');
 if not p_admin then select coalesce(jsonb_agg(x),'[]') into values_json from jsonb_array_elements(values_json) x where (x->>'visible')::boolean; end if;
 select max(e.received_at) into latest from public.funnel_metric_events e where e.product_id=product and e.funnel_id=funnel and (affiliate is null or e.affiliate_id=affiliate) and (link is null or e.link_id=link) and e.occurred_at>=v.published_at and (v.archived_at is null or e.occurred_at<v.archived_at);
 select exists(select 1 from public.external_commerce_merchants m where m.product_id=product and m.funnel_id=funnel and m.enabled) into commerce_connected;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into currencies from (
 select o.currency,o.livemode,count(*) filter(where e.kind='purchase') as purchases,count(*) filter(where e.kind='refund') as refunds,
 coalesce(sum(e.amount_minor) filter(where e.kind='purchase'),0) as gross_minor,coalesce(sum(e.amount_minor) filter(where e.kind='refund'),0) as refunded_minor,
 sum(case when e.kind='purchase' then e.amount_minor else -e.amount_minor end) as net_minor
 from public.external_commerce_orders o join public.external_commerce_events e on e.order_id=o.id join public.clicks click on click.id=o.click_record_id
 where o.product_id=product and o.funnel_id=funnel and (affiliate is null or o.affiliate_id=affiliate) and (link is null or click.affiliate_link_id=link) and e.provider_occurred_at>=starts and e.provider_occurred_at<ends group by o.currency,o.livemode order by o.currency,o.livemode) c;
 select max(e.created_at) into commerce_latest from public.external_commerce_orders o join public.external_commerce_events e on e.order_id=o.id join public.clicks click on click.id=o.click_record_id where o.product_id=product and o.funnel_id=funnel and (affiliate is null or o.affiliate_id=affiliate) and (link is null or click.affiliate_link_id=link);
 commerce:=jsonb_build_object('source','external_verified_ledger','availability',case when commerce_connected or commerce_latest is not null then 'available' else 'unconnected' end,'commission_status','held','currencies',currencies,'last_received_at',commerce_latest);
 return jsonb_build_object('product_id',product,'funnel_id',funnel,'version',v.version,'published_at',v.published_at,'effective_until',v.archived_at,'as_of',asof,'last_received_at',latest,'status',case when v.version is null then 'unpublished' when latest is null then 'awaiting_data' else 'connected' end,'metrics',values_json,'commerce',commerce);
end;$$;
create function public.get_admin_funnel_metrics_report(p_input jsonb) returns jsonb language sql stable security definer set search_path='' as $$select public.funnel_metrics_report(p_input,true);$$;
create function public.get_partner_funnel_metrics_report(p_input jsonb) returns jsonb language sql stable security definer set search_path='' as $$select public.funnel_metrics_report(p_input,false);$$;
create function public.preview_admin_funnel_metrics(p_input jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare samples jsonb; event jsonb; metrics jsonb;
begin
 if not public.current_user_is_admin() then raise exception 'Admin access required' using errcode='42501'; end if;
 if not exists(select 1 from public.funnels where id=(p_input->>'funnel_id')::uuid) then raise exception 'Funnel not found' using errcode='P0002'; end if;
 metrics:=p_input->'metrics'; samples:=p_input->'sample_events'; perform public.validate_funnel_metric_definitions(metrics);
 if jsonb_typeof(samples) is distinct from 'array' or jsonb_array_length(samples)>100 then raise exception 'Use at most 100 isolated sample events' using errcode='22023'; end if;
 for event in select value from jsonb_array_elements(samples) loop perform public.validate_funnel_metric_event(event,true); end loop;
 if exists(select 1 from jsonb_array_elements(samples) e where e ? 'event_id' group by e->>'event_id' having count(*)>1) then raise exception 'Sample event IDs must be unique; retries must reuse the original evidence' using errcode='22023'; end if;
 return jsonb_build_object('preview',true,'metrics',public.compute_funnel_metrics(metrics,null,null,null,null,'2000-01-01',statement_timestamp(),null,null,statement_timestamp(),samples));
end;$$;

-- Helpers and raw evidence never become a browser API. Only narrow admin/self
-- reports and definition operations are callable by authenticated users.
revoke all on function public.guard_funnel_metric_version(),public.validate_funnel_metric_definitions(jsonb),public.validate_funnel_metric_event(jsonb,boolean),public.funnel_metric_rows(uuid,uuid,uuid,uuid,timestamptz,timestamptz,jsonb),public.compute_funnel_metrics(jsonb,uuid,uuid,uuid,uuid,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz,jsonb),public.funnel_metrics_report(jsonb,boolean),public.ingest_funnel_metric_event(uuid,uuid,jsonb),public.get_admin_funnel_metrics_config(uuid),public.save_admin_funnel_metrics_draft(jsonb),public.publish_admin_funnel_metrics(uuid,integer),public.get_admin_funnel_metrics_report(jsonb),public.get_partner_funnel_metrics_report(jsonb),public.preview_admin_funnel_metrics(jsonb),public.validate_admin_funnel_metric_event(jsonb) from public,anon,authenticated;
grant execute on function public.ingest_funnel_metric_event(uuid,uuid,jsonb) to service_role;
grant execute on function public.get_admin_funnel_metrics_config(uuid),public.save_admin_funnel_metrics_draft(jsonb),public.publish_admin_funnel_metrics(uuid,integer),public.get_admin_funnel_metrics_report(jsonb),public.get_partner_funnel_metrics_report(jsonb),public.preview_admin_funnel_metrics(jsonb),public.validate_admin_funnel_metric_event(jsonb) to authenticated;
commit;
