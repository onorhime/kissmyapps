-- Links a merchant console workspace to its merchant business, so a workspace
-- owner can connect Stripe from the console without an admin invitation.
-- This migration creates no connection and enables nothing by itself.
begin;
alter table public.merchant_businesses
  add column workspace_id uuid references public.analytics_workspaces(id) on delete set null;
create unique index merchant_business_one_workspace
  on public.merchant_businesses(workspace_id) where workspace_id is not null;
commit;
