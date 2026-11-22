begin;

-- A commission inquiry records the question and the reviewed answer. Money moves
-- only through the existing commission, refund and payout workflows.
create table kma_internal.program_inquiries (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.affiliate_programs on delete cascade,
  affiliate_id uuid not null references public.affiliates on delete cascade,
  reference text not null check (length(reference) between 1 and 160),
  question text not null check (length(question) between 5 and 1000),
  response text check (length(response) between 5 and 1000),
  answered_by uuid references auth.users,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index program_inquiry_reference on kma_internal.program_inquiries(program_id,affiliate_id,lower(reference));
create index program_inquiries_creator on kma_internal.program_inquiries(affiliate_id,created_at desc,id desc);
create index program_inquiries_program on kma_internal.program_inquiries(program_id,created_at desc,id desc);
revoke all on kma_internal.program_inquiries from public,anon,authenticated,service_role;

create function public.partner_ask_commission(p_program uuid,p_reference text,p_question text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  creator uuid:=public.current_partner_affiliate_id(true);
  inquiry uuid;
  ref text:=trim(p_reference);
  question text:=trim(p_question);
begin
  if not exists(select 1 from public.affiliate_program_members where program_id=p_program and affiliate_id=creator
                and status in ('active','left','removed')) then
    raise exception 'Program membership required' using errcode='42501';
  end if;
  if coalesce(length(ref),0) not between 1 and 160 or coalesce(length(question),0) not between 5 and 1000 then
    raise exception 'Supply an order reference and a short question' using errcode='22023';
  end if;
  insert into kma_internal.program_inquiries(program_id,affiliate_id,reference,question)
    values(p_program,creator,ref,question) on conflict do nothing returning id into inquiry;
  if inquiry is null then
    select id into strict inquiry from kma_internal.program_inquiries
      where program_id=p_program and affiliate_id=creator and lower(reference)=lower(ref);
  else
    insert into kma_internal.program_notices(workspace_id,reference,label,action)
      select p.workspace_id,inquiry,p.name||' · Creator asked about a commission','sales' from public.affiliate_programs p where p.id=p_program;
  end if;
  return inquiry;
end $$;

create function public.workspace_answer_commission(p_workspace uuid,p_inquiry uuid,p_response text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  response_text text:=trim(p_response);
  q kma_internal.program_inquiries;
begin
  perform kma_internal.analytics_require_workspace(p_workspace,'admin');
  if coalesce(length(response_text),0) not between 5 and 1000 then raise exception 'Enter a short answer' using errcode='22023'; end if;
  select i.* into q from kma_internal.program_inquiries i join public.affiliate_programs p on i.program_id=p.id
    where p.workspace_id=p_workspace and i.id=p_inquiry for update of i;
  if q.id is null then raise exception 'Unknown inquiry' using errcode='22023'; end if;
  if q.answered_at is not null then
    if q.response=response_text then return q.id; end if;
    raise exception 'This inquiry already has an answer' using errcode='22023';
  end if;
  update kma_internal.program_inquiries set response=response_text,answered_at=now(),answered_by=auth.uid() where id=q.id;
  insert into kma_internal.program_notices(affiliate_id,reference,label,action) values(q.affiliate_id,q.id,'Merchant answered your commission inquiry','earnings');
  return q.id;
end $$;

create function public.program_inquiries_page(p_workspace uuid,p_before_at timestamptz,p_before_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare creator uuid;
begin
  if p_workspace is null then creator:=public.current_partner_affiliate_id(true);
  else perform kma_internal.analytics_require_workspace(p_workspace,'admin'); end if;
  if (p_before_at is null)<>(p_before_id is null) then raise exception 'Invalid inquiry cursor' using errcode='22023'; end if;
  return (with page as materialized (
    select i.id,i.created_at,i.reference,i.question,i.response,i.answered_at,p.name program
    from kma_internal.program_inquiries i join public.affiliate_programs p on p.id=i.program_id
    where ((p_workspace is null and i.affiliate_id=creator) or p.workspace_id=p_workspace)
      and (p_before_at is null or (i.created_at,i.id)<(p_before_at,p_before_id))
    order by i.created_at desc,i.id desc limit 51
  ), visible as (select * from page order by created_at desc,id desc limit 50)
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(v) order by created_at desc,id desc) from visible v),'[]'::jsonb),
    'more',(select count(*)>50 from page),
    'programs',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) order by p.name,p.id)
      from public.affiliate_programs p join public.affiliate_program_members m on m.program_id=p.id
      where p_workspace is null and m.affiliate_id=creator and m.status in ('active','left','removed')),'[]'::jsonb)));
end $$;

revoke all on function public.partner_ask_commission(uuid,text,text),public.workspace_answer_commission(uuid,uuid,text),public.program_inquiries_page(uuid,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.partner_ask_commission(uuid,text,text),public.workspace_answer_commission(uuid,uuid,text),public.program_inquiries_page(uuid,timestamptz,uuid) to authenticated;
create function kma_internal.program_terms_notice() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into kma_internal.program_notices(affiliate_id,reference,label,action)
    select m.affiliate_id,new.id,new.name||' · Published terms version '||new.live_terms_version,'terms/'||new.slug
    from public.affiliate_program_members m where m.program_id=new.id and m.status='active';
  return new;
end $$;
revoke all on function kma_internal.program_terms_notice() from public,anon,authenticated,service_role;
create trigger program_terms_change_notice after update of live_terms_version on public.affiliate_programs for each row
when(old.live_terms_version is not null and new.live_terms_version is distinct from old.live_terms_version and new.live_terms_version is not null)
execute function kma_internal.program_terms_notice();

commit;
