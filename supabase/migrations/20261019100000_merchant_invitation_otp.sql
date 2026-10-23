-- A valid invitation authorizes sending one email code to its saved recipient.
-- No browser RPC privileges, membership, financial gate or scheduled job changes.
begin;
create table kma_internal.merchant_invitation_code_requests (
 request_id uuid primary key,invitation_id uuid not null references public.merchant_invitations,
 recipient text not null,recipient_origin text not null,status text not null check(status in('sending','sent','failed','unknown','cooldown')),
 send_started boolean not null default false,lease_id uuid not null default gen_random_uuid(),
 created_at timestamptz not null default clock_timestamp(),retry_at timestamptz not null,
 lease_expires_at timestamptz not null,finished_at timestamptz
);
create index merchant_invitation_code_recipient_rate on kma_internal.merchant_invitation_code_requests(recipient,created_at desc) where send_started;
revoke all on kma_internal.merchant_invitation_code_requests from public,anon,authenticated,service_role;

create function public.prepare_merchant_invitation_code(p_token_sha256 text,p_request_id uuid,p_recipient_origin text) returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.merchant_invitations;r kma_internal.merchant_invitation_code_requests;latest kma_internal.merchant_invitation_code_requests;next_at timestamptz;send_now boolean:=false;
begin
 if coalesce(p_token_sha256,'')!~'^[a-f0-9]{64}$' or p_request_id is null or coalesce(p_recipient_origin,'')!~'^https?://[^/?#]+$' then raise exception 'Invitation unavailable' using errcode='22023';end if;
 select * into i from public.merchant_invitations where token_sha256=p_token_sha256;
 if i.id is null then raise exception 'Invitation unavailable' using errcode='P0002';end if;
 perform pg_advisory_xact_lock(hashtextextended('merchant-invitation-code:'||i.email,0));
 select * into i from public.merchant_invitations where id=i.id for share;
 if (i.claimed_by is not null and not exists(select 1 from auth.users where id=i.claimed_by and email_confirmed_at is not null and lower(trim(email))=i.email)) or i.revoked_at is not null or i.confirmed_at is not null or i.expires_at<=clock_timestamp() or not exists(select 1 from public.merchant_connections where id=i.connection_id and status<>'revoked') then raise exception 'Invitation unavailable' using errcode='P0002';end if;
 select * into r from kma_internal.merchant_invitation_code_requests where request_id=p_request_id;
 if r.request_id is not null then
  if r.invitation_id<>i.id or r.recipient_origin<>p_recipient_origin then raise exception 'Invitation request unavailable' using errcode='22023';end if;
 else
  select * into latest from kma_internal.merchant_invitation_code_requests where recipient=i.email and send_started order by created_at desc,request_id desc limit 1;
  next_at:=greatest(clock_timestamp(),latest.retry_at);
  if (select count(*) from kma_internal.merchant_invitation_code_requests where recipient=i.email and send_started and created_at>clock_timestamp()-interval '1 hour')>=5 then
   select greatest(next_at,min(created_at)+interval '1 hour') into next_at from kma_internal.merchant_invitation_code_requests where recipient=i.email and send_started and created_at>clock_timestamp()-interval '1 hour';
  end if;
  send_now:=next_at<=clock_timestamp();
  insert into kma_internal.merchant_invitation_code_requests(request_id,invitation_id,recipient,recipient_origin,status,send_started,retry_at,lease_expires_at)
   values(p_request_id,i.id,i.email,p_recipient_origin,case when send_now then 'sending' else 'cooldown' end,send_now,case when send_now then clock_timestamp()+interval '60 seconds' else next_at end,clock_timestamp()+interval '30 seconds') returning * into r;
 end if;
 return jsonb_build_object('send',send_now,'request_id',r.request_id,'lease_id',case when send_now then r.lease_id else null end,'email',i.email,'expires_at',i.expires_at,'status',case when r.status='sending' then case when r.lease_expires_at>clock_timestamp() then 'cooldown' else 'unknown' end else r.status end,'retry_at',r.retry_at);
end $$;

create function public.finish_merchant_invitation_code(p_request_id uuid,p_lease_id uuid,p_status text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r kma_internal.merchant_invitation_code_requests;
begin
 if p_status is null or p_status not in('sent','failed','unknown') then raise exception 'Invalid code send receipt' using errcode='22023';end if;
 update kma_internal.merchant_invitation_code_requests set status=p_status,finished_at=clock_timestamp() where request_id=p_request_id and lease_id=p_lease_id and send_started and status='sending' returning * into r;
 if r.request_id is null then raise exception 'Code send lease unavailable' using errcode='55000';end if;
 return jsonb_build_object('email',r.recipient,'expires_at',(select expires_at from public.merchant_invitations where id=r.invitation_id),'status',r.status,'retry_at',r.retry_at);
end $$;
revoke all on function public.prepare_merchant_invitation_code(text,uuid,text),public.finish_merchant_invitation_code(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.prepare_merchant_invitation_code(text,uuid,text),public.finish_merchant_invitation_code(uuid,uuid,text) to service_role;
commit;
