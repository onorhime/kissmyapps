begin;

-- On-demand locator, not a public URL. Storage performs its own authorization
-- again when the authenticated browser requests a short-lived signed URL.
create or replace function public.get_partner_document_download(p_document_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in to access partner documents' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'document_id', document.id,
    'bucket', 'affiliate-private-documents',
    'file_path', document.file_path
  ) into result
  from public.documents as document
  where document.id = p_document_id
    and document.status <> 'draft'
    and public.current_user_has_affiliate(document.affiliate_id)
    and public.current_user_can_download_storage_object(
      'affiliate-private-documents', document.file_path
    )
    and exists (
      select 1 from storage.objects as object
      where object.bucket_id = 'affiliate-private-documents'
        and object.name = document.file_path
        and (
          document.document_type <> 'partner_agreement'
          or (
            document.storage_object_id = object.id
            and document.storage_version is not distinct from object.version
            and document.storage_etag is not distinct from (object.metadata ->> 'eTag')
          )
        )
    );

  -- Use the same response for nonexistent, private and unavailable documents.
  if result is null then
    raise exception 'This document is not available to your account' using errcode = '42501';
  end if;
  return result;
end;
$$;

revoke all on function public.get_partner_document_download(uuid) from public, anon;
grant execute on function public.get_partner_document_download(uuid) to authenticated;
comment on function public.get_partner_document_download(uuid) is
  'Partner-owned, non-draft private file locator; no product launch or traffic requirement.';

commit;
