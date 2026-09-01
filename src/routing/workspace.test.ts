import { describe, expect, it } from 'vitest'
import {
  canonicalWorkspaceHash,
  defaultWorkspaceForHostname,
  explicitWorkspaceFromHash,
  initialWorkspace,
  productionWorkspaceForHostname,
  productionWorkspaceUrl,
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
    ['admin.kissmyapps.dev', 'admin'],
    ['partners.kissmyapps.dev', 'partner'],
    ['localhost', null],
  ] as const)('recognizes %s as the production %s workspace', (hostname, workspace) => {
    expect(productionWorkspaceForHostname(hostname)).toBe(workspace)
  })

  it.each([
    ['#admin/overview', 'admin'],
    ['#admin/products/product%2Fone/configuration', 'admin'],
    ['#admin/funnels-links', 'admin'],
    ['#admin/attribution', 'admin'],
    ['#admin/data-health', 'admin'],
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

  it('keeps the Admin hostname authoritative over a Partner hash', () => {
    expect(
      initialWorkspace({
        hash: '#payouts',
        hostname: 'admin.kissmyapps.dev',
        previewMode: false,
      }),
    ).toBe('admin')
  })

  it('keeps the Partner hostname authoritative over an Admin hash', () => {
    expect(
      initialWorkspace({
        hash: '#admin/products',
        hostname: 'partners.kissmyapps.dev',
        previewMode: false,
      }),
    ).toBe('partner')
  })

  it.each([
    ['admin.kissmyapps.dev', '#performance', '#admin/overview'],
    ['admin.kissmyapps.dev', '#payouts', '#admin/overview'],
    ['partners.kissmyapps.dev', '#admin/products', '#performance'],
    ['partners.kissmyapps.dev', '#admin/affiliates', '#performance'],
    ['partners.kissmyapps.dev', '#admin/funnels-links', '#performance'],
    ['partners.kissmyapps.dev', '#admin/attribution', '#performance'],
    ['partners.kissmyapps.dev', '#admin/data-health', '#performance'],
    ['admin.kissmyapps.dev', '#auth/sign-in', null],
    ['partners.kissmyapps.dev', '#auth/reset', null],
    ['localhost', '#admin/products', null],
  ] as const)('canonicalizes %s %s to %s', (hostname, hash, expected) => {
    expect(canonicalWorkspaceHash({ hostname, hash })).toBe(expected)
  })

  it('keeps the Admin production hostname authoritative in preview mode', () => {
    expect(
      initialWorkspace({
        hash: '',
        hostname: 'admin.kissmyapps.dev',
        previewMode: true,
      }),
    ).toBe('admin')
  })

  it('preserves the Partner showroom default on a local preview host', () => {
    expect(
      initialWorkspace({
        hash: '',
        hostname: 'localhost',
        previewMode: true,
      }),
    ).toBe('partner')
  })

  it('keeps explicit Admin routes available to the local UI showroom', () => {
    expect(
      initialWorkspace({
        hash: '#admin/affiliates',
        hostname: 'localhost',
        previewMode: true,
      }),
    ).toBe('admin')
  })

  it('keeps hash-based workspace switching available on localhost', () => {
    expect(
      initialWorkspace({ hash: '#admin/products', hostname: 'localhost', previewMode: false }),
    ).toBe('admin')
  })

  it('builds canonical production workspace URLs', () => {
    expect(productionWorkspaceUrl('partner')).toBe('https://partners.kissmyapps.dev/#performance')
    expect(productionWorkspaceUrl('admin')).toBe('https://admin.kissmyapps.dev/#admin/overview')
    expect(
      productionWorkspaceUrl('partner', {
        pathname: '/',
        search: '?auth_action=signup&type=email&token_hash=one-time-secret',
        hash: '',
      }),
    ).toBe(
      'https://partners.kissmyapps.dev/?auth_action=signup&type=email&token_hash=one-time-secret',
    )
  })
})
