import { describe, expect, it } from 'vitest'
import type { Attribution, AttributionLinks, AttributionSources } from './api'
import { attributionBackendFixture as backend } from './attribution-backend.fixture'
import {
  acquisitionLine,
  clipboardHandoff,
  installsOf,
  linkInstalls,
  readAcquisition,
  readTestDevice,
  sourceHint,
  sourceInstalls,
  sourceLabel,
  testChecks,
  testFinished,
  totalInstalls,
} from './attribution'

const copy = <T>(value: unknown) => structuredClone(value) as T
const view = () => copy<Attribution>(backend.attribution_get_with_installs)
const links = () => copy<AttributionLinks>(backend.attribution_links_with_installs)
const sources = () => copy<AttributionSources>(backend.attribution_sources_with_installs)
const phoneTest = '659ccdeb-57b5-437c-8f06-9243da2ccb91'

// App installs on the attribution screens against what the database functions really return.
describe('attribution installs and the real backend answers', () => {
  it('reads the installs matched for the project, and its clipboard handoff', () => {
    const answer = view()
    expect(installsOf(answer)).toEqual({ total: 30, last_at: '2026-11-13T20:33:10.079+00:00' })
    expect(clipboardHandoff(answer)).toBe(true)
    expect(answer.setup).toMatchObject({ apps: true, domain: true, sdk: true, conversions: false })
  })

  it('reads installs and re-engagements for each link', () => {
    const answer = links()
    expect(answer.links.map((link) => [link.name, linkInstalls(link)])).toEqual([
      ['Lesson 4', { installs: 7, reengagements: 1 }],
      ['Bio link', { installs: 2, reengagements: 1 }],
      ['Phone test', { installs: 1, reengagements: 0 }],
      ['Old mail', { installs: 0, reengagements: 0 }],
    ])
  })

  it('reads installs for each source, with organic installs under no source', () => {
    const answer = sources()
    expect(answer.rows.map((row) => [sourceLabel(row.key), sourceInstalls(row)])).toEqual([
      ['TikTok', 6],
      ['Instagram', 3],
      ['QR code', 1],
      ['Apple Ads', 1],
      ['Direct or unknown', 12],
    ])
    expect(totalInstalls(answer)).toBe(23)
    expect(sourceHint('apple_ads')).toBe('App installs Apple matched to a search ad')
    // Without the database's own total, the rows add up to the same.
    delete answer.totals.installs
    expect(totalInstalls(answer)).toBe(23)
  })

  it('reads a phone test that has seen the click, then the install and the deep link', () => {
    const waiting = readTestDevice(backend.attribution_test_device_waiting, phoneTest)
    expect(waiting).toEqual({
      link: { id: phoneTest, url: 'https://fluent.go.kissmyapps.dev/qr-test' },
      click: { at: '2026-11-13T20:30:40.079+00:00', platform: 'android' },
      install: null,
      deep_link_delivered: false,
    })
    expect(testChecks(waiting, true).map((check) => check.state)).toEqual([
      'done',
      'waiting',
      'later',
    ])
    expect(testFinished(testChecks(waiting, true))).toBe(false)

    const done = readTestDevice(backend.attribution_test_device_done, phoneTest)
    expect(done.install).toEqual({
      at: '2026-11-13T20:31:40.079+00:00',
      method: 'install_referrer',
      platform: 'android',
      exact: true,
    })
    expect(done.deep_link_delivered).toBe(true)
    expect(testChecks(done, true).map((check) => check.state)).toEqual(['done', 'done', 'done'])
    expect(testFinished(testChecks(done, true))).toBe(true)
    // A link that opens no screen has no deep link to wait for.
    expect(testChecks(waiting, false)[2].state).toBe('off')
  })

  it('says where a person came from, how exact the match is and whether it counted', () => {
    const answer = backend.analytics_person_acquired as { acquisition: unknown }
    const acquisition = readAcquisition(answer.acquisition)!
    expect(acquisition).toEqual({
      source: 'instagram',
      campaign: 'reels',
      method: 'link_open',
      exact: true,
      installed_at: '2026-11-13T20:18:40.079+00:00',
      link_name: 'Lesson 4',
      verdict: 'counted',
    })
    expect(acquisitionLine(acquisition)).toBe(
      'Acquired from Instagram, reels, matched by a link that opened the app (exact)',
    )
    expect(
      acquisitionLine({
        ...acquisition,
        source: 'tiktok',
        campaign: 'launch',
        method: 'install_referrer',
        exact: false,
        verdict: 'flagged',
      }),
    ).toBe(
      'Acquired from TikTok, launch, matched by Google Play install referrer (likely), marked for review',
    )
    expect(acquisitionLine({ ...acquisition, verdict: 'rejected' })).toBe(
      'Install not counted: the click came after the install',
    )
    expect(
      acquisitionLine({ ...acquisition, source: 'apple_ads', campaign: null, method: 'apple_ads' }),
    ).toBe('Acquired from Apple Ads, matched by Apple Ads (exact)')
    expect(
      acquisitionLine({ ...acquisition, source: 'tiktok', campaign: null, method: 'clipboard' }),
    ).toBe('Acquired from TikTok, matched by clipboard handoff (exact)')
    expect(
      acquisitionLine({ ...acquisition, source: 'tiktok', campaign: null, method: 'login' }),
    ).toBe('Acquired from TikTok, matched by sign-in after a web visit (exact)')
    expect(acquisitionLine({ ...acquisition, source: null, method: 'organic' })).toBe(
      'Installed with no link (organic)',
    )
    expect(acquisitionLine({ ...acquisition, source: null, method: 'reinstall' })).toBe(
      'Installed, with no source credited',
    )
  })

  it('reads an older database, with nothing about installs, as none', () => {
    const old = view()
    delete old.installs
    delete old.settings!.ios_clipboard_handoff
    expect(installsOf(old)).toEqual({ total: 0, last_at: null })
    expect(clipboardHandoff(old)).toBe(false)
    const link = links().links[0]
    delete link.installs
    delete link.reengagements
    expect(linkInstalls(link)).toEqual({ installs: 0, reengagements: 0 })
    const report = sources()
    delete report.totals.installs
    report.rows.forEach((row) => delete row.installs)
    expect(totalInstalls(report)).toBe(0)
    expect(readAcquisition(undefined)).toBeNull()
    expect(readAcquisition(null)).toBeNull()
    expect(readAcquisition({ method: 'teleport' })).toBeNull()
    // An answer from before verdicts counts the install it sends.
    const person = backend.analytics_person_acquired as { acquisition: Record<string, unknown> }
    const noVerdict = { ...person.acquisition }
    delete noVerdict.verdict
    expect(readAcquisition(noVerdict)?.verdict).toBe('counted')
    const nothing = readTestDevice(null, 'link-1')
    expect(nothing).toEqual({
      link: { id: 'link-1', url: null },
      click: null,
      install: null,
      deep_link_delivered: false,
    })
    expect(testChecks(nothing, true).map((check) => check.state)).toEqual([
      'waiting',
      'later',
      'later',
    ])
  })
})
