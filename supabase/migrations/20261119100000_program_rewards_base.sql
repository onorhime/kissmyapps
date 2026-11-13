-- Affiliate self-serve, Phase 6: programs that pay per event. The storage only.
--
-- A program can pay creators for sales, for events, or for both. An event is something a
-- person does on the merchant's site or app that the merchant's analytics already receives
-- (a sign-up, a trial started). The merchant lists up to five of them with an amount each:
-- the program's rewards.
--
-- An event has no payment behind it, so it is kept honest by rules a sale does not need:
-- each reward is earned once per person, by the creator whose link that person clicked
-- last inside the counting window; the merchant sets a monthly budget; one creator can use
-- only a share of it per day; and the merchant can reject a reward during its hold.
--
-- The money runs through what sales already use. A reward that earns gets a row in
-- program_commissions (with award_id in place of sale_id), so the amount and the KissMyApps
-- fee are set aside from the merchant's prepaid balance the moment it is earned, become the
-- creator's after the hold, and are paid out like any commission.
--
-- Events programs need program money (platform_settings.program_money_enabled). Nothing
-- here acts by itself.
begin;

-- The share of a program's monthly reward budget that one creator can earn in one day
-- (1000 = 10%), so one creator cannot use up the month overnight.
alter table public.platform_settings
  add column program_reward_daily_share_bps integer not null default 1000
    check (program_reward_daily_share_bps between 100 and 10000);

-- What creators earn from, the rewards, and the monthly budget for them.
-- rewards: [{"key": "<event name>", "label": "<what creators read>", "amount_minor": <n>}],
-- in the order the merchant listed them. The functions that save a program check each item.
alter table public.affiliate_programs
  add column earn_from text not null default 'sales' check (earn_from in ('sales', 'events', 'both')),
  add column rewards jsonb not null default '[]'::jsonb
    check (jsonb_typeof(rewards) = 'array' and jsonb_array_length(rewards) <= 5),
  -- In minor units of the program's currency, per calendar month (UTC). The KissMyApps fee
  -- comes on top of it. Not part of the terms: the merchant can change it at any time.
  add column reward_budget_minor bigint check (reward_budget_minor between 100 and 100000000);

-- A published program is complete for what it pays for: a commission for sales, rewards
-- and a budget for events.
alter table public.affiliate_programs drop constraint affiliate_program_published_complete;
alter table public.affiliate_programs add constraint affiliate_program_published_complete check (
  status in ('draft', 'changes_requested', 'archived')
  or (name is not null and category is not null and tagline is not null and landing_url is not null
    and (earn_from = 'events' or (commission_type is not null and commission_duration is not null))
    and (earn_from = 'sales' or (jsonb_array_length(rewards) > 0 and reward_budget_minor is not null))));

-- One judgement of one event that came through a creator's link. Events of people no
-- creator sent are not kept here.
--   earned: the reward was set aside from the merchant's balance; its commission row says
--     where the money is now (held, approved).
--   not_earned: it counts for nothing; `reason` says why.
--   rejected: it had earned, and the merchant took it back during the hold.
-- event_id and person_id name rows of analytics_events and analytics_people. They are
-- plain values: analytics data can be purged, a record of money cannot.
create table public.program_reward_awards (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.affiliate_programs(id),
  reward_key text not null check (reward_key ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$'),
  reward_label text not null check (length(btrim(reward_label)) between 1 and 40),
  event_id bigint not null unique,
  person_id uuid not null,
  occurred_at timestamptz not null,
  member_id uuid references public.affiliate_program_members(id),
  affiliate_id uuid not null references public.affiliates(id),
  -- The click that earned it: the last creator link the person opened inside the window.
  click_record_id uuid references public.clicks(id),
  terms_version integer,
  status text not null check (status in ('earned', 'not_earned', 'rejected')),
  reason text check (reason in (
    'not_a_member', 'not_in_terms', 'already_rewarded', 'own_action', 'budget_reached',
    'daily_limit', 'balance_empty', 'program_paused', 'currency_mismatch')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  -- The reward as the terms named it, also when it did not earn.
  amount_minor bigint not null check (amount_minor > 0),
  rejected_by uuid references auth.users(id),
  rejected_at timestamptz,
  reject_reason text check (reject_reason in ('fake', 'duplicate', 'own_action', 'low_quality', 'other')),
  reject_note text check (length(reject_note) between 1 and 300),
  created_at timestamptz not null default now(),
  foreign key (program_id, terms_version) references public.affiliate_program_terms(program_id, version),
  constraint program_reward_award_reason check ((status = 'not_earned') = (reason is not null)),
  constraint program_reward_award_earning_shape check (
    status = 'not_earned' or (member_id is not null and terms_version is not null)),
  constraint program_reward_award_rejected check (
    (status = 'rejected') = (rejected_at is not null)
    and (status = 'rejected') = (reject_reason is not null)
    and (reject_note is null or status = 'rejected'))
);
-- Once per person: a person who earned a reward, or whose reward was rejected, does not
-- earn that reward of that program again.
create unique index program_reward_awards_once
  on public.program_reward_awards(program_id, reward_key, person_id) where status in ('earned', 'rejected');
create index program_reward_awards_program on public.program_reward_awards(program_id, occurred_at desc, id);
create index program_reward_awards_creator on public.program_reward_awards(affiliate_id, program_id, occurred_at desc);
create index program_reward_awards_click on public.program_reward_awards(click_record_id)
  where click_record_id is not null;

-- A commission is now for a sale or for a reward, never both.
alter table public.program_commissions alter column sale_id drop not null;
alter table public.program_commissions
  add column award_id uuid unique references public.program_reward_awards(id);
alter table public.program_commissions add constraint program_commission_subject
  check ((sale_id is null) <> (award_id is null));
alter table public.program_commissions drop constraint program_commissions_commission_type_check;
alter table public.program_commissions add constraint program_commissions_commission_type_check
  check (commission_type in ('percent', 'fixed', 'reward'));
-- A reward's commission always earns (an event that earns nothing has no commission row),
-- and only a reward's commission has the type 'reward'.
alter table public.program_commissions add constraint program_commission_reward_shape
  check ((award_id is not null) = (commission_type is not distinct from 'reward')
    and (award_id is null or status <> 'not_earned'));
-- A sale of a program that pays for events only earns nothing.
alter table public.program_commissions drop constraint program_commissions_reason_check;
alter table public.program_commissions add constraint program_commissions_reason_check
  check (reason in (
    'no_creator', 'not_a_member', 'outside_duration', 'currency_mismatch', 'program_paused',
    'balance_empty', 'zero_amount', 'refunded', 'sales_not_rewarded'));
create index program_commissions_reward_hold on public.program_commissions(hold_until)
  where status = 'held' and award_id is not null;

-- Which event names of which analytics project a program pays for, kept in step with the
-- programs by the functions of this phase. It is what lets the event intake decide with one
-- key lookup that an event is of no interest.
create table public.program_reward_events (
  project_id uuid not null references public.analytics_projects(id) on delete cascade,
  event_name text not null,
  program_id uuid not null references public.affiliate_programs(id),
  primary key (project_id, event_name)
);
create index program_reward_events_program on public.program_reward_events(program_id);

-- Events waiting to be judged. A row is removed when its event has been judged.
create table public.program_reward_queue (
  event_id bigint primary key,
  project_id uuid not null,
  event_name text not null,
  person_id uuid not null,
  session_id uuid,
  occurred_at timestamptz not null,
  enqueued_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text check (length(last_error) between 1 and 200)
);
create index program_reward_queue_due on public.program_reward_queue(next_attempt_at, event_id);

alter table public.program_reward_awards enable row level security;
alter table public.program_reward_events enable row level security;
alter table public.program_reward_queue enable row level security;
revoke all on public.program_reward_awards, public.program_reward_events, public.program_reward_queue
  from public, anon, authenticated, service_role;

commit;
