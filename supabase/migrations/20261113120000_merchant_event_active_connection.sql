-- A Stripe account can now be released by one workspace and connected by another,
-- so a revoked row and an active row can share (platform, account, livemode).
-- Account events from Stripe must land on the active row. The only change to this
-- function is the row choice: the active connection first, then the newest.
begin;
create or replace function public.apply_merchant_connection_event(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$declare c public.merchant_connections;previous public.merchant_connection_events;begin
 if p_input->>'event_type' not in('account.updated','account.application.deauthorized') or coalesce(p_input->>'event_id','')!~'^evt_[A-Za-z0-9_]+$' or jsonb_typeof(p_input->'event_created') is distinct from 'number' or (p_input->>'event_created')::bigint<=0 or coalesce(p_input->>'payload_sha256','')!~'^[a-f0-9]{64}$' then raise exception 'Invalid merchant event' using errcode='22023';end if;
 select * into c from public.merchant_connections where platform_account_id=p_input->>'platform_account_id' and account_id=p_input->>'account_id' and livemode=(p_input->>'livemode')::boolean order by (status='active') desc,confirmed_at desc nulls last,id limit 1 for update;
 if c.id is null then return jsonb_build_object('matched',false);end if;
 select * into previous from public.merchant_connection_events where platform_account_id=c.platform_account_id and livemode=c.livemode and event_id=p_input->>'event_id';
 if found then if previous.account_id<>c.account_id or previous.event_type<>p_input->>'event_type' or previous.event_created<>to_timestamp((p_input->>'event_created')::double precision) or previous.payload_sha256<>p_input->>'payload_sha256' then raise exception 'Merchant event identity changed' using errcode='22023';end if;return jsonb_build_object('matched',true,'status',c.status,'replayed',true);end if;
 insert into public.merchant_connection_events values(c.platform_account_id,c.livemode,p_input->>'event_id',c.account_id,to_timestamp((p_input->>'event_created')::double precision),p_input->>'event_type',p_input->>'payload_sha256');
 if p_input->>'event_type'='account.application.deauthorized' and c.confirmed_at is not null and to_timestamp((p_input->>'event_created')::double precision)<date_trunc('second',c.confirmed_at) then return jsonb_build_object('matched',true,'status',c.status,'ignored_historical',true);end if;
 if p_input->>'event_type'='account.application.deauthorized' then
  update public.merchant_connections set status='revoked',revoked_at=clock_timestamp() where id=c.id returning * into c;
  update public.merchant_invitations set revoked_at=coalesce(revoked_at,clock_timestamp()) where connection_id=c.id;
 elsif (p_input->>'provider_verified_at')::timestamptz>coalesce(c.verified_at,'-infinity'::timestamptz) and c.status<>'revoked' then
  if jsonb_typeof(p_input->'charges_enabled') is distinct from 'boolean' or jsonb_typeof(p_input->'details_submitted') is distinct from 'boolean' or jsonb_typeof(p_input->'payouts_enabled') is distinct from 'boolean' or (p_input->>'provider_verified_at')::timestamptz>clock_timestamp()+interval '5 minutes' then raise exception 'Complete verified merchant capabilities required' using errcode='22023';end if;
  update public.merchant_connections set charges_enabled=(p_input->>'charges_enabled')::boolean,payouts_enabled=(p_input->>'payouts_enabled')::boolean,details_submitted=(p_input->>'details_submitted')::boolean,verified_at=(p_input->>'provider_verified_at')::timestamptz where id=c.id returning * into c;
 end if;
 return jsonb_build_object('matched',true,'status',c.status);end $$;
commit;
