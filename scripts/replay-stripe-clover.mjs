// Requeue only the user's two failed, signed $0-test events after compatibility deployment.
import {execFileSync} from 'node:child_process'
const sql=`begin;set local lock_timeout='3s';do $$ declare r record; n int:=0; begin
for r in select q.*,e.provider_event_id external_id from public.provider_event_processing q join public.provider_events e on e.id=q.provider_event_id
where e.id in ('1f350d0c-6dc9-4118-b98e-7fe5310db546','14a1746e-0e47-468c-b0b8-5379a0c0053f')
and e.provider='stripe' and e.signature_verified and e.payload->'livemode'='true'::jsonb
and e.provider_event_id in ('evt_1UCmHdE47mNwFlz1kotthZsA','evt_1UCmHeE47mNwFlz1tAbINOqF') for update of q loop
if r.status<>'failed' or r.processing_error not in ('invalid_subscription_state','invoice_not_paid') then raise exception 'Replay state changed';end if;
insert into public.audit_logs(actor_type,action,target_table,target_id,reason,before_data,after_data)values
('service','stripe.compatibility_replay','provider_event_processing',r.provider_event_id,'User-approved Clover compatibility repair; original signed payload unchanged',jsonb_build_object('status',r.status,'error',r.processing_error),' {"status":"pending"}');
update public.provider_event_processing set status='pending',next_attempt_at=now(),processing_error=null where provider_event_id=r.provider_event_id;n:=n+1;
end loop;if n<>2 then raise exception 'Expected exactly two events';end if;end $$;commit;select 'two_original_events_requeued' result;`;
try {console.log(execFileSync('pnpm',['exec','supabase','db','query','--linked','--project-ref','mmyruzjemjecqyivhrgr','--file','/dev/stdin','--output','json'],{input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000}));}catch(e){console.error(e.stderr?.toString());process.exitCode=1}
