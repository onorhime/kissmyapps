begin;

-- Compare the revision seen by the editor under the same row lock as the write.
-- Earlier clients retain the original save and delete entry points.
create function public.analytics_edit_funnel(p_project uuid,p_funnel uuid,p_expected timestamptz,p_name text,p_steps jsonb,p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare revision timestamptz;
begin
  perform kma_internal.analytics_require_project(p_project);
  select updated_at into strict revision from public.analytics_funnels where id=p_funnel and project_id=p_project for update;
  if revision is distinct from p_expected then raise exception 'This shared funnel changed. Reopen the current version before saving.' using errcode='40001'; end if;
  return public.analytics_save_funnel(p_project,p_funnel,p_name,p_steps,p_window_seconds);
end $$;

create function public.analytics_remove_funnel(p_project uuid,p_funnel uuid,p_expected timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare revision timestamptz;
begin
  perform kma_internal.analytics_require_project(p_project);
  select updated_at into strict revision from public.analytics_funnels where id=p_funnel and project_id=p_project for update;
  if revision is distinct from p_expected then raise exception 'This shared funnel changed. Reopen the current version before deleting.' using errcode='40001'; end if;
  return public.analytics_delete_funnel(p_funnel);
end $$;
revoke all on function public.analytics_edit_funnel(uuid,uuid,timestamptz,text,jsonb,integer),public.analytics_remove_funnel(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.analytics_edit_funnel(uuid,uuid,timestamptz,text,jsonb,integer),public.analytics_remove_funnel(uuid,uuid,timestamptz) to authenticated;

commit;
