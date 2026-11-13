import { describe, expect, it } from 'vitest'
import { linksBackendFixture as backend } from '../../../merchant/links-backend.fixture'
import { mapPartnerProduct } from '../api/mappers'
import { isLegacyProduct } from './legacyLinks'
import {
  addedLink,
  customLinksLeft,
  displayAddress,
  linkNameProblem,
  linkStatusLine,
  mainLink,
  otherLinks,
  readLinkProgram,
  readProgramLinks,
} from './links'

// What the database really answers: the "capture" lines of
// supabase/tests/database/83_program_links.sql, kept in links-backend.fixture.ts.

const CHANNELS = ['TikTok', 'Instagram', 'YouTube', 'Facebook', 'X', 'Newsletter']

describe('creator links read from real database output', () => {
  it('reads a creator in no program as nothing to list', () => {
    const links = readProgramLinks(backend.partner_program_links_empty)
    expect(links.programs).toEqual([])
    expect(links.stats_days).toBe(30)
    expect(links.max_custom_links).toBe(20)
    expect(links.channels.map((channel) => channel.name)).toEqual(CHANNELS)
  })

  it('reads a new member: a main link and one link per channel, nothing counted', () => {
    const [program, ...rest] = readProgramLinks(backend.partner_program_links_one_program).programs
    expect(rest).toEqual([])
    expect(program).toMatchObject({
      slug: 'speaksix',
      name: 'SpeakSix',
      currency: 'USD',
      working: true,
      paused_reason: null,
      custom_links: 0,
    })
    expect(displayAddress(mainLink(program).url)).toBe('go.kissmyapps.dev/speaksix/ada-okafor')
    expect(otherLinks(program).map((link) => [link.kind, link.name])).toEqual(
      CHANNELS.map((name) => ['channel', name]),
    )
    for (const link of program.links) {
      expect(link.url.startsWith('https://go.kissmyapps.dev/speaksix/ada-okafor')).toBe(true)
      expect([link.clicks, link.sales, link.earnings_minor, link.removable]).toEqual([
        0,
        0,
        0,
        false,
      ])
      expect(Number.isFinite(Date.parse(link.created_at ?? ''))).toBe(true)
    }
    expect(customLinksLeft(program, 20)).toBe(20)
  })

  it('reads two programs with clicks, sales and earnings per link', () => {
    const links = readProgramLinks(backend.partner_program_links_two_programs)
    expect(links.programs.map((program) => program.slug)).toEqual(['rival-reader', 'speaksix'])
    const speaksix = links.programs[1]
    const rows = Object.fromEntries(
      speaksix.links.map((link) => [link.name, [link.clicks, link.sales, link.earnings_minor]]),
    )
    expect(rows).toMatchObject({
      'Main link': [2, 2, 4200],
      TikTok: [3, 1, 1470],
      Instagram: [2, 0, 0],
      Podcast: [1, 1, 600],
      'Blog post': [1, 0, 0],
      'Old bio': [0, 0, 0],
    })
    expect(speaksix.custom_links).toBe(3)
    expect(customLinksLeft(speaksix, links.max_custom_links)).toBe(17)
    // A link that has ever been opened stays, even with nothing in these 30 days.
    expect(speaksix.links.filter((link) => link.removable)).toEqual([])
    expect(linkNameProblem('podcast', speaksix)).not.toBeNull()
    expect(linkNameProblem('main  link', speaksix)).not.toBeNull()
    expect(linkNameProblem('Reddit', speaksix)).toBeNull()
  })

  it('reads why a program is not paying: paused by the merchant, or out of balance', () => {
    const paused = readProgramLinks(backend.partner_program_links_paused).programs
    expect(paused.map((program) => [program.slug, program.working, program.paused_reason])).toEqual(
      [
        ['rival-reader', false, 'program_paused'],
        ['speaksix', true, null],
      ],
    )
    const [dry] = readProgramLinks(backend.partner_program_links_balance_empty).programs
    expect([dry.slug, dry.working, dry.paused_reason]).toEqual([
      'quiet-club',
      false,
      'balance_empty',
    ])
    const lines = [paused[0], paused[1], dry].map(linkStatusLine)
    expect(new Set(lines).size).toBe(3)
  })

  it('reads the program as it is after a custom link is added, and after one is removed', () => {
    const before = readProgramLinks(backend.partner_program_links_one_program).programs[0]
    const added = readLinkProgram(backend.partner_program_link_create_first)
    expect(added.slug).toBe(before.slug)
    expect(added.custom_links).toBe(1)
    expect(addedLink(before, added)).toMatchObject({
      kind: 'custom',
      name: 'Podcast',
      url: 'https://go.kissmyapps.dev/speaksix/ada-okafor/podcast',
      removable: true,
      clicks: 0,
    })
    const removed = readLinkProgram(backend.partner_program_link_remove_done)
    expect(removed.custom_links).toBe(2)
    expect(removed.links.filter((link) => link.kind === 'custom').map((link) => link.name)).toEqual(
      ['Podcast', 'Blog post'],
    )
  })
})

describe('the creator product list read from real database output', () => {
  it('holds a program’s product, which is not a product from before programs', () => {
    const rows = backend.partner_product_directory_program_only as unknown[]
    const products = rows.map(mapPartnerProduct)
    expect(products.map((product) => product.slug).sort()).toEqual(['rival-reader', 'speaksix'])
    // So the Links and Performance pages show the program pages alone for this creator.
    expect(products.filter(isLegacyProduct)).toEqual([])
  })
})
