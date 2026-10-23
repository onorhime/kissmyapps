-- Direct, admin-requested invitation mail. No scheduler or financial gates change.
begin;
create table kma_internal.merchant_invitation_requests (
 request_id uuid primary key, actor_id uuid not null references auth.users,
 invitation_id uuid not null unique references public.merchant_invitations,
 key_id text not null check(key_id~'^[A-Za-z0-9_-]{1,40}$'),
 input jsonb not null, created_at timestamptz not null default clock_timestamp()
);
create table kma_internal.merchant_invitation_deliveries (
 id uuid primary key, invitation_id uuid not null references public.merchant_invitations,
 actor_id uuid not null references auth.users, status text not null check(status in('sending','sent','failed','unknown')),
 envelope_fields jsonb not null, envelope_sha256 text not null check(envelope_sha256~'^[a-f0-9]{64}$'),
 lease_id uuid not null, leased_until timestamptz not null, first_attempt_at timestamptz not null default clock_timestamp(),
 last_attempt_at timestamptz not null default clock_timestamp(), attempts integer not null default 1,
 retry_at timestamptz not null, provider_id text, error_code text,
 check(provider_id is null or provider_id~'^[A-Za-z0-9_-]{1,160}$'),check(error_code is null or error_code~'^[a-z0-9_]{1,80}$')
);
create index merchant_invitation_delivery_latest on kma_internal.merchant_invitation_deliveries(invitation_id,first_attempt_at desc);
create table kma_internal.merchant_invitation_delivery_requests (
 request_id uuid primary key, actor_id uuid not null references auth.users,
 invitation_id uuid not null references public.merchant_invitations,
 delivery_id uuid not null references kma_internal.merchant_invitation_deliveries
);
revoke all on kma_internal.merchant_invitation_requests,kma_internal.merchant_invitation_deliveries,kma_internal.merchant_invitation_delivery_requests from public,anon,authenticated,service_role;

create function kma_internal.merchant_invitation_delivery_view(p_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare i public.merchant_invitations;d kma_internal.merchant_invitation_deliveries;active boolean;s text;retry timestamptz;
begin
 select * into i from public.merchant_invitations where id=p_id;
 select * into d from kma_internal.merchant_invitation_deliveries where invitation_id=p_id order by first_attempt_at desc,id desc limit 1;
 active:=exists(select 1 from kma_internal.merchant_invitation_requests where invitation_id=p_id) and i.id is not null and i.revoked_at is null and i.confirmed_at is null and i.expires_at>clock_timestamp() and exists(select 1 from public.merchant_connections where id=i.connection_id and status<>'revoked');
 s:=case when d.id is null then 'not_sent' when d.status='sending' and d.leased_until<=clock_timestamp() then 'unknown' else d.status end;
 retry:=case when s='sending' then greatest(d.retry_at,d.leased_until) else d.retry_at end;
 return jsonb_build_object('status',s,'recipient',i.email,'retry_at',retry,'can_retry',active and (s<>'sending') and coalesce(d.error_code,'')<>'provider_payload_conflict' and (retry is null or retry<=clock_timestamp()) and (s not in('unknown','failed') or (d.first_attempt_at>clock_timestamp()-interval '23 hours' and d.attempts<5)));
end $$;

create function public.get_admin_merchant_invitation_delivery(p_invitation_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare i public.merchant_invitations;r kma_internal.merchant_invitation_requests;
begin
 perform public.assert_admin_password(array['owner','operations'],'view a merchant invitation');
 select * into i from public.merchant_invitations where id=p_invitation_id;
 if i.id is null then raise exception 'Merchant invitation unavailable' using errcode='P0002';end if;
 select * into r from kma_internal.merchant_invitation_requests where invitation_id=i.id;
 return kma_internal.merchant_invitation_view(i)||jsonb_build_object('token_request_id',r.request_id,'token_key_id',r.key_id,'token_sha256',i.token_sha256,'delivery',kma_internal.merchant_invitation_delivery_view(i.id));
end $$;

create function public.create_admin_merchant_invitation_v2(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid:=(p_input->>'request_id')::uuid;r kma_internal.merchant_invitation_requests;v jsonb;canonical jsonb:=p_input-'expires_at'-'token_sha256'-'key_id';
begin
 perform public.assert_admin_password(array['owner','operations'],'invite a merchant');
 canonical:=canonical||jsonb_build_object('request_id',rid);
 if p_input->>'merchant_id' is not null then canonical:=jsonb_set(canonical,'{merchant_id}',to_jsonb((p_input->>'merchant_id')::uuid));end if;
 if rid is null or coalesce(p_input->>'key_id','')!~'^[A-Za-z0-9_-]{1,40}$' then raise exception 'Request identity required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('merchant-invitation-create:'||rid::text,0));
 select * into r from kma_internal.merchant_invitation_requests where request_id=rid;
 if r.request_id is not null then
  if r.actor_id<>auth.uid() or r.input<>canonical then raise exception 'Request identity conflict' using errcode='22023';end if;
  return public.get_admin_merchant_invitation_delivery(r.invitation_id);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('merchant-invitation-actor:'||auth.uid()::text,0));
 if (select count(*) from kma_internal.merchant_invitation_requests where actor_id=auth.uid() and created_at>clock_timestamp()-interval '1 hour')>=20 then raise exception 'Invitation rate limit' using errcode='55000';end if;
 perform pg_advisory_xact_lock(hashtextextended('merchant-invitation-email:'||lower(trim(p_input->>'email')),0));
 if exists(select 1 from kma_internal.merchant_invitation_deliveries d join public.merchant_invitations i on i.id=d.invitation_id where i.email=lower(trim(p_input->>'email')) and d.retry_at>clock_timestamp()) then raise exception 'Invitation email cooldown' using errcode='55000';end if;
 v:=public.create_admin_merchant_invitation(p_input);
 insert into kma_internal.merchant_invitation_requests(request_id,actor_id,invitation_id,key_id,input) values(rid,auth.uid(),(v->>'invitation_id')::uuid,p_input->>'key_id',canonical);
 return public.get_admin_merchant_invitation_delivery((v->>'invitation_id')::uuid);
end $$;

create function public.prepare_admin_merchant_invitation_email(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.merchant_invitations;d kma_internal.merchant_invitation_deliveries;m kma_internal.merchant_invitation_delivery_requests;rid uuid:=(p_input->>'request_id')::uuid;fields jsonb:=p_input->'envelope_fields';sha text:=p_input->>'envelope_sha256';lease uuid;v jsonb;
begin
 perform public.assert_admin_password(array['owner','operations'],'email a merchant invitation');
 if rid is null then raise exception 'Request identity required' using errcode='22023';end if;
 -- A recipient-wide lock closes concurrent hourly-limit races across merchants/admins.
 select * into i from public.merchant_invitations where id=(p_input->>'invitation_id')::uuid;
 if i.id is null then raise exception 'Merchant invitation unavailable' using errcode='P0002';end if;
 perform pg_advisory_xact_lock(hashtextextended('merchant-invitation-email-actor:'||auth.uid()::text,0));
 perform pg_advisory_xact_lock(hashtextextended('merchant-invitation-email:'||i.email,0));
 select * into i from public.merchant_invitations where id=i.id for update;
 if i.revoked_at is not null or i.confirmed_at is not null or i.expires_at<=clock_timestamp() or not exists(select 1 from public.merchant_connections where id=i.connection_id and status<>'revoked') or not exists(select 1 from kma_internal.merchant_invitation_requests where invitation_id=i.id) then raise exception 'Merchant invitation unavailable' using errcode='55000';end if;
 select * into m from kma_internal.merchant_invitation_delivery_requests where request_id=rid;
 if m.request_id is not null then
  if m.actor_id<>auth.uid() or m.invitation_id<>i.id then raise exception 'Request identity conflict' using errcode='22023';end if;
  select * into d from kma_internal.merchant_invitation_deliveries where id=m.delivery_id;
 else
  select * into d from kma_internal.merchant_invitation_deliveries where invitation_id=i.id order by first_attempt_at desc,id desc limit 1;
  if d.id is not null and d.status='sent' and d.retry_at<=clock_timestamp() then d:=null;end if;
 end if;
 if d.id is not null then
  if m.request_id is null then insert into kma_internal.merchant_invitation_delivery_requests values(rid,auth.uid(),i.id,d.id);end if;
  if d.status='sent' or d.retry_at>clock_timestamp() or (d.status='sending' and d.leased_until>clock_timestamp()) or d.first_attempt_at<=clock_timestamp()-interval '23 hours' or d.attempts>=5 or d.error_code='provider_payload_conflict' then
   return jsonb_build_object('send',false,'delivery',kma_internal.merchant_invitation_delivery_view(i.id));
  end if;
  -- Reconstruct from frozen fields, not current sender/business configuration.
  if sha is null or fields is null or fields<>d.envelope_fields or sha<>d.envelope_sha256 then
   return jsonb_build_object('send',false,'needs_frozen_envelope',true,'envelope_fields',d.envelope_fields,'envelope_sha256',d.envelope_sha256,'delivery',kma_internal.merchant_invitation_delivery_view(i.id));
  end if;
 else
  if fields is null or jsonb_typeof(fields)<>'object' or fields->>'to' is distinct from i.email or fields->>'business_name' is distinct from (select business_name from public.merchant_businesses where id=i.merchant_id) or (fields->>'expires_at')::timestamptz is distinct from i.expires_at or fields->'template_version' is distinct from '1'::jsonb or length(coalesce(fields->>'from','')) not between 3 and 254 or fields->>'from'~E'[\r\n]' or coalesce(fields->>'origin','')!~'^https?://[^/?#]+$' or (select count(*) from jsonb_object_keys(fields))<>6 or coalesce(sha,'')!~'^[a-f0-9]{64}$' then raise exception 'Invalid email envelope' using errcode='22023';end if;
  if (select count(*) from kma_internal.merchant_invitation_deliveries x join public.merchant_invitations z on z.id=x.invitation_id where z.email=i.email and x.first_attempt_at>clock_timestamp()-interval '1 hour')>=5 or (select count(*) from kma_internal.merchant_invitation_deliveries where actor_id=auth.uid() and first_attempt_at>clock_timestamp()-interval '1 hour')>=20 then raise exception 'Email rate limit' using errcode='55000';end if;
  insert into kma_internal.merchant_invitation_deliveries(id,invitation_id,actor_id,status,envelope_fields,envelope_sha256,lease_id,leased_until,retry_at,attempts) values(gen_random_uuid(),i.id,auth.uid(),'unknown',fields,sha,gen_random_uuid(),clock_timestamp(),clock_timestamp(),0) returning * into d;
  insert into kma_internal.merchant_invitation_delivery_requests values(rid,auth.uid(),i.id,d.id);
 end if;
 lease:=gen_random_uuid();
 update kma_internal.merchant_invitation_deliveries set status='sending',lease_id=lease,leased_until=clock_timestamp()+interval '30 seconds',retry_at=clock_timestamp()+interval '60 seconds',last_attempt_at=clock_timestamp(),attempts=attempts+1 where id=d.id returning * into d;
 return jsonb_build_object('send',true,'delivery_id',d.id,'lease_id',lease,'idempotency_key','merchant-invitation/'||d.id::text,'envelope_fields',d.envelope_fields,'envelope_sha256',d.envelope_sha256,'delivery',kma_internal.merchant_invitation_delivery_view(i.id));
end $$;

create function public.finish_merchant_invitation_email(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare d kma_internal.merchant_invitation_deliveries;
begin
 if coalesce(p_input->>'status','') not in('sent','failed','unknown') or ((p_input->>'status')='sent' and coalesce(p_input->>'provider_id','')!~'^[A-Za-z0-9_-]{1,160}$') or (p_input->>'error_code' is not null and p_input->>'error_code'!~'^[a-z0-9_]{1,80}$') then raise exception 'Invalid delivery receipt' using errcode='22023';end if;
 update kma_internal.merchant_invitation_deliveries set status=p_input->>'status',provider_id=p_input->>'provider_id',error_code=p_input->>'error_code',leased_until=clock_timestamp() where id=(p_input->>'delivery_id')::uuid and lease_id=(p_input->>'lease_id')::uuid and status='sending' returning * into d;
 if d.id is null then raise exception 'Delivery lease unavailable' using errcode='55000';end if;
 return kma_internal.merchant_invitation_delivery_view(d.invitation_id);
end $$;

create or replace function public.get_admin_merchant_connections() returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 perform public.assert_admin_password(array['owner','operations','finance'],'view merchant connections');
 return jsonb_build_object('merchants',coalesce((select jsonb_agg(to_jsonb(b)||jsonb_build_object('connections',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('latest_invitation',(select jsonb_build_object('invitation_id',i.id,'expires_at',i.expires_at,'status',kma_internal.merchant_invitation_view(i)->>'status','can_copy',exists(select 1 from kma_internal.merchant_invitation_requests where invitation_id=i.id) and i.revoked_at is null and i.confirmed_at is null and i.expires_at>clock_timestamp() and c.status<>'revoked','delivery',kma_internal.merchant_invitation_delivery_view(i.id)) from public.merchant_invitations i where i.connection_id=c.id order by i.created_at desc,i.id desc limit 1))) from public.merchant_connections c where c.merchant_id=b.id),'[]'::jsonb))) from public.merchant_businesses b),'[]'::jsonb),'assignments',coalesce((select jsonb_agg(to_jsonb(a)) from public.product_merchant_connections a),'[]'::jsonb));end $$;
revoke all on function kma_internal.merchant_invitation_delivery_view(uuid) from public,anon,authenticated,service_role;
revoke all on function public.get_admin_merchant_invitation_delivery(uuid),public.create_admin_merchant_invitation_v2(jsonb),public.prepare_admin_merchant_invitation_email(jsonb),public.finish_merchant_invitation_email(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_admin_merchant_invitation_delivery(uuid),public.create_admin_merchant_invitation_v2(jsonb),public.prepare_admin_merchant_invitation_email(jsonb) to authenticated;
grant execute on function public.finish_merchant_invitation_email(jsonb) to service_role;
commit;
