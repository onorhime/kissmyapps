import { describe, expect, it } from 'vitest'
import {
  defaultWorkspaceForHostname,
  explicitWorkspaceFromHash,
  initialWorkspace,
} from './workspace'

describe('production workspace host routing', () => {
  it.each([
    ['admin.kissmyapps.dev', 'admin'],
    ['ADMIN.KISSMYAPPS.DEV.', 'admin'],
    ['partners.kissmyapps.dev', 'partner'],
    ['localhost', 'partner'],
    ['', 'partner'],
  ] as const)('defaults %s to the %s workspace', (hostname, workspace) => {
    expect(defaultWorkspaceForHostname(hostname)).toBe(workspace)
  })

  it.each([
    ['#admin/overview', 'admin'],
    ['#admin/products/product%2Fone/configuration', 'admin'],
    ['#admin', 'admin'],
    ['#performance', 'partner'],
    ['#payouts', 'partner'],
    ['#links/source', 'partner'],
    ['#profile/payment', 'partner'],
    ['#auth/sign-in', null],
    ['#auth/sign-up', null],
    ['#auth/invite', null],
    ['', null],
    ['#unknown', null],
  ] as const)('recognizes the explicit workspace in %s', (hash, workspace) => {
    expect(explicitWorkspaceFromHash(hash)).toBe(workspace)
  })

  it('lets an explicit partner route override the admin hostname', () => {
    expect(
      initialWorkspace({
        hash: '#payouts',
        hostname: 'admin.kissmyapps.dev',
        previewMode: false,
      }),
    ).toBe('partner')
  })

  it('lets an explicit admin route override the partner hostname', () => {
    expect(
      initialWorkspace({
        hash: '#admin/products',
        hostname: 'partners.kissmyapps.dev',
        previewMode: false,
      }),
    ).toBe('admin')
  })

  it('preserves the partner showroom default in preview and test mode', () => {
    expect(
      initialWorkspace({
        hash: '',
        hostname: 'admin.kissmyapps.dev',
        previewMode: true,
      }),
    ).toBe('partner')
  })
})
