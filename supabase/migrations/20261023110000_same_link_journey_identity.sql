-- Same-link anonymous-to-verified journey linkage only. No history, creator
-- credit, commercial ledger, commission settings or processing gates change.
begin;
create or replace function public.validate_funnel_metric_event(p_event jsonb,p_sample boolean default false) returns boolean language plpgsql stable set search_path='' as $$
declare k text; extra text[]:=array['schema_version','environment','dedupe_key','aliased_subject_id','anonymous_id','order_id','checkout_session_id','assessment_attempt_id','registration_id','group_id','resource_id','event_source','funnel_version','entry_route','utm_source','utm_medium','utm_campaign','host_type','request_source','state_revision','aliased_click_id'];
begin
 if not(p_event ? 'schema_version') then return public.validate_funnel_metric_event_v1(p_event,p_sample);end if;
 if p_event->>'schema_version'<>'2' or p_event->>'environment' is null or p_event->>'environment' not in('test','live') or coalesce(p_event->>'dedupe_key','')!~'^[A-Za-z0-9_.:-]{1,160}$' or pg_column_size(p_event)>8192 or exists(select 1 from jsonb_each(p_event) x where jsonb_typeof(x.value)<>'string') then raise exception 'Journey v2 requires environment and stable business key' using errcode='22023';end if;
 if p_event ? 'state_revision' and coalesce(p_event->>'state_revision','')!~'^[1-9][0-9]{0,8}$' then raise exception 'State revision must be a positive bounded integer' using errcode='22023';end if;
 perform public.validate_funnel_metric_event_v1(p_event-extra,p_sample);
 foreach k in array extra[4:array_length(extra,1)] loop
 if p_event ? k and coalesce(p_event->>k,'')!~'^[A-Za-z0-9_-]{1,128}$' then raise exception 'Journey references must be opaque codes' using errcode='22023';end if;
 end loop;
 foreach k in array array['aliased_subject_id','anonymous_id','aliased_click_id'] loop if p_event ? k and coalesce(p_event->>k,'')!~'^[A-Za-z0-9_-]{16,128}$' then raise exception 'Identity references must be opaque' using errcode='22023';end if;end loop;
 if (p_event ? 'aliased_subject_id' or p_event ? 'aliased_click_id' or p_event->>'event_name'='identity_linked') and (p_event->>'event_name' is distinct from 'identity_linked' or p_event->>'state_value' is distinct from 'verified' or not(p_event ? 'aliased_subject_id') or p_event->>'aliased_subject_id'=p_event->>'subject_id') then raise exception 'Identity link requires verified ownership and distinct previous subject' using errcode='22023';end if;
 if p_event->>'event_name'=any(array['purchase_completed','refund_status_updated','payment_status_updated','dispute_status_updated','commission_status_updated','payout_status_updated']) then raise exception 'Financial truth requires verified commerce ingestion' using errcode='22023';end if;
 return true;
end;$$;

create or replace function public.ingest_funnel_metric_event_before_link_environments(p_product_id uuid,p_funnel_id uuid,p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.clicks; a public.acquisitions; prior public.funnel_metric_events; i public.funnel_journey_identities; old_i public.funnel_journey_identities; saved uuid; env text:=p_event->>'environment'; defs jsonb; alias_click public.clicks;
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
 -- The stable learner retains its credited click. A signed, verified alias
 -- may carry the anonymous visit's different token, but both tokens must be
 -- independently stored valid clicks from this exact link and journey scope.
 -- Initialize each identity with its own click so delivery order cannot assign
 -- the anonymous token to the stable learner (or the reverse).
 alias_click:=c;
 if p_event ? 'aliased_click_id' then
  perform public.assert_funnel_request_scope('metric-identity-alias',p_event->>'aliased_click_id',p_product_id,p_funnel_id);
  select other.* into alias_click from public.clicks other
  join public.funnel_journey_clicks classified on classified.click_record_id=other.id and classified.environment=env
  join public.affiliate_links link on link.id=other.affiliate_link_id
  where other.public_click_id=p_event->>'aliased_click_id' and other.product_id=p_product_id and other.funnel_id=p_funnel_id
   and other.affiliate_link_id=c.affiliate_link_id and other.affiliate_id=c.affiliate_id and not other.is_bot
   and link.product_id=p_product_id and link.funnel_id=p_funnel_id and link.affiliate_id=c.affiliate_id
   and (link.tracking_environment is null or link.tracking_environment=env)
   and exists(select 1 from public.acquisitions acquisition where acquisition.click_record_id=other.id
    and acquisition.product_id=p_product_id and acquisition.funnel_id=p_funnel_id and acquisition.affiliate_id=c.affiliate_id and acquisition.status in('open','resolved'));
  if alias_click.id is null or (p_event->>'occurred_at')::timestamptz<alias_click.occurred_at-interval '5 minutes' then raise exception 'Identity alias requires a valid click from the same link and environment' using errcode='22023';end if;
 end if;
 insert into public.funnel_journey_identities(product_id,funnel_id,environment,subject_id,canonical_subject_id,click_record_id) values(p_product_id,p_funnel_id,env,p_event->>'aliased_subject_id',p_event->>'aliased_subject_id',alias_click.id) on conflict do nothing;
 select * into old_i from public.funnel_journey_identities where product_id=p_product_id and funnel_id=p_funnel_id and environment=env and subject_id=p_event->>'aliased_subject_id';
 if old_i.click_record_id<>alias_click.id or (old_i.verified and old_i.canonical_subject_id<>i.canonical_subject_id) then raise exception 'Identity linkage cannot replace a verified identity or credited click' using errcode='23505';end if;
 update public.funnel_journey_identities set canonical_subject_id=i.canonical_subject_id,verified=true where product_id=p_product_id and funnel_id=p_funnel_id and environment=env and canonical_subject_id in(old_i.canonical_subject_id,i.canonical_subject_id);
 elsif p_event->>'event_name'='email_verified' then update public.funnel_journey_identities set verified=true where product_id=p_product_id and funnel_id=p_funnel_id and environment=env and canonical_subject_id=i.canonical_subject_id;
 end if;
 insert into public.funnel_metric_events(external_event_id,product_id,funnel_id,affiliate_id,link_id,click_record_id,acquisition_id,event_name,subject_id,context_id,session_id,state_value,occurred_at,presence_expires_at,evidence,journey_environment,business_key)
 values((p_event->>'event_id')::uuid,p_product_id,p_funnel_id,c.affiliate_id,c.affiliate_link_id,c.id,a.id,p_event->>'event_name',p_event->>'subject_id',p_event->>'context_id',p_event->>'session_id',p_event->>'state_value',(p_event->>'occurred_at')::timestamptz,(p_event->>'presence_expires_at')::timestamptz,p_event,env,p_event->>'dedupe_key') returning id into saved;
 return jsonb_build_object('event_id',saved,'duplicate',false);
end;$$;

commit;
