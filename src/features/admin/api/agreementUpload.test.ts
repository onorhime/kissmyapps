import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminGateway } from './gateway'

const storage = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn(), from: vi.fn() }))
vi.mock('../../../lib/supabase', () => ({ supabase: { storage: { from: storage.from } } }))
const input = {
  affiliateId: 'affiliate-1',
  agreementId: 'agreement-1',
  file: new File(['%PDF-audit'], 'Audit terms.pdf', { type: 'application/pdf' }),
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  storage.from.mockReturnValue(storage)
  storage.upload.mockImplementation(async (path: string) => ({ data: { path }, error: null }))
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
describe('agreement PDF evidence and cleanup', () => {
  it('sends the actual PDF digest and a partner-scoped non-overwriting upload', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        id: 'document-1',
        name: 'Audit terms',
        version: 1,
        status: 'awaiting_partner_signature',
      },
      error: null,
    }))
    const result = await createAdminGateway({ rpc }).uploadAgreementDocument!(input)
    expect(result.status).toBe('ready')
    const bytes = new TextEncoder().encode('%PDF-audit')
    const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex')
    expect(rpc).toHaveBeenCalledWith('create_admin_agreement_document', {
      p_input: expect.objectContaining({
        content_sha256: digest,
        file_path: expect.stringMatching(/^affiliate-1\/agreements\/agreement-1\//),
      }),
    })
    expect(storage.upload).toHaveBeenCalledWith(expect.any(String), input.file, {
      contentType: 'application/pdf',
      upsert: false,
    })
    expect(storage.remove).not.toHaveBeenCalled()
  })
  it.each([false, true])(
    'reports recording and cleanup outcomes separately (cleanup error %s)',
    async (cleanupFails) => {
      const rpc = vi.fn(async (name: string) => ({
        data: null,
        error:
          name === 'request_admin_document_cleanup'
            ? cleanupFails
              ? { code: '42501' }
              : null
            : { code: 'P0001' },
      }))
      const result = await createAdminGateway({ rpc }).uploadAgreementDocument!(input)
      expect(result.status).toBe('error')
      expect(result.error?.message).toContain(
        cleanupFails ? 'may remain stored' : 'queued for secure cleanup',
      )
      expect(rpc).toHaveBeenLastCalledWith('request_admin_document_cleanup', {
        p_file_path: expect.stringMatching(/^affiliate-1\/agreements\/agreement-1\//),
      })
      expect(storage.remove).not.toHaveBeenCalled()
    },
  )
  it('does not upload when the data gateway is unconfigured', async () => {
    expect((await createAdminGateway(null).uploadAgreementDocument!(input)).status).toBe(
      'unconfigured',
    )
    expect(storage.upload).not.toHaveBeenCalled()
  })
})
