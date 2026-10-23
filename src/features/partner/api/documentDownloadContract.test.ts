import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync('supabase/migrations/20260905130000_partner_document_download.sql', 'utf8')

describe('document download SQL source contract (not a hosted authorization test)', () => {
  it('keeps download authorization bound to the current partner and existing private object', () => {
    expect(sql).toContain('if auth.uid() is null')
    expect(sql).toContain('document.id = p_document_id')
    expect(sql).toContain("document.status <> 'draft'")
    expect(sql).toContain('public.current_user_has_affiliate(document.affiliate_id)')
    expect(sql).toContain('public.current_user_can_download_storage_object(')
    expect(sql).toContain("object.bucket_id = 'affiliate-private-documents'")
    expect(sql).toContain('object.name = document.file_path')
  })

  it('checks that an agreement PDF still matches its recorded Storage identity', () => {
    expect(sql).toContain('document.storage_object_id = object.id')
    expect(sql).toContain('document.storage_version is not distinct from object.version')
    expect(sql).toContain("document.storage_etag is not distinct from (object.metadata ->> 'eTag')")
  })

  it('grants only authenticated use, fixes search_path, and does not write or require launch', () => {
    expect(sql).toContain("stable\nsecurity definer\nset search_path = ''")
    expect(sql).toContain('from public, anon')
    expect(sql).toContain('to authenticated')
    expect(sql).not.toMatch(/\b(insert into|update public|delete from|alter table)\b/i)
    expect(sql).not.toContain('public.products')
    expect(sql).not.toContain('public.funnels')
    expect(sql).not.toContain('billing_offers')
  })
})
