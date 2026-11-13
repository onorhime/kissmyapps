// Sample answers of the Phase 5 link functions (`partner_program_links`,
// `partner_program_link_create`, `partner_program_link_remove`), written by hand for the page
// tests and the screenshots: busy programs, many links, long names. The reader is also checked
// against what the database really prints, in links.backend.test.ts.

const CHANNELS = [
  { key: 'tiktok', name: 'TikTok' },
  { key: 'instagram', name: 'Instagram' },
  { key: 'youtube', name: 'YouTube' },
  { key: 'facebook', name: 'Facebook' },
  { key: 'x', name: 'X' },
  { key: 'newsletter', name: 'Newsletter' },
]

type Counts = [clicks: number, sales: number, earningsMinor: number]

const NOTHING: Counts = [0, 0, 0]

function link(
  id: string,
  kind: 'main' | 'channel' | 'custom',
  name: string,
  url: string,
  [clicks, sales, earningsMinor]: Counts,
  extra: Record<string, unknown> = {},
) {
  return {
    link_id: id,
    kind,
    channel: null,
    name,
    url,
    created_at: '2026-11-02T09:14:07.512846+00:00',
    clicks,
    sales,
    earnings_minor: earningsMinor,
    removable: false,
    ...extra,
  }
}

/** The main link and the six channel links every member has. */
function standardLinks(
  programNumber: number,
  base: string,
  main: Counts = NOTHING,
  channels: Partial<Record<string, Counts>> = {},
) {
  const id = (linkNumber: number) =>
    `00000000-0000-4000-8000-${String(programNumber).padStart(4, '0')}${String(linkNumber).padStart(8, '0')}`
  return [
    link(id(0), 'main', 'Main link', base, main),
    ...CHANNELS.map((channel, index) =>
      link(
        id(index + 1),
        'channel',
        channel.name,
        `${base}/${channel.key}`,
        channels[channel.key] ?? NOTHING,
        { channel: channel.key },
      ),
    ),
  ]
}

function customLink(
  programNumber: number,
  linkNumber: number,
  name: string,
  url: string,
  counts: Counts = NOTHING,
  createdAt = '2026-11-06T16:40:21.090114+00:00',
) {
  return link(
    `00000000-0000-4000-8000-${String(programNumber).padStart(4, '0')}${String(linkNumber).padStart(8, '0')}`,
    'custom',
    name,
    url,
    counts,
    { created_at: createdAt, removable: counts[0] === 0 },
  )
}

const SPEAKSIX = 'https://go.kissmyapps.dev/speaksix/ada'

const speaksixLinks = standardLinks(1, SPEAKSIX, [58, 0, 0], {
  tiktok: [1840, 46, 27600],
  instagram: [622, 11, 6600],
  youtube: [304, 9, 5400],
  newsletter: [96, 4, 2400],
})

const speaksix = {
  program_id: '00000000-0000-4000-8000-000000000001',
  slug: 'speaksix',
  name: 'SpeakSix',
  currency: 'USD',
  working: true,
  paused_reason: null,
  custom_links: 2,
  links: [
    ...speaksixLinks,
    customLink(
      1,
      101,
      'Podcast',
      `${SPEAKSIX}/podcast`,
      [212, 5, 3000],
      '2026-11-04T10:02:55.330912+00:00',
    ),
    customLink(1, 102, 'Bio link', `${SPEAKSIX}/bio-link`),
  ],
}

const dramapal = {
  program_id: '00000000-0000-4000-8000-000000000002',
  slug: 'dramapal',
  name: 'DramaPal',
  currency: 'USD',
  working: true,
  paused_reason: null,
  custom_links: 0,
  links: standardLinks(2, 'https://go.kissmyapps.dev/dramapal/ada', [140, 3, 2175], {
    tiktok: [960, 21, 15225],
    instagram: [84, 0, 0],
  }),
}

const loopHabits = {
  program_id: '00000000-0000-4000-8000-000000000003',
  slug: 'loop-habits',
  name: 'Loop Habits',
  currency: 'EUR',
  working: false,
  paused_reason: 'balance_empty',
  custom_links: 0,
  links: standardLinks(3, 'https://go.kissmyapps.dev/loop-habits/ada', [31, 1, 1200], {
    youtube: [18, 0, 0],
  }),
}

/** A member who joined today: every link is there and nothing has happened on any of them. */
const fieldnote = {
  program_id: '00000000-0000-4000-8000-000000000004',
  slug: 'fieldnote',
  name: 'Fieldnote',
  currency: 'USD',
  working: true,
  paused_reason: null,
  custom_links: 0,
  links: standardLinks(4, 'https://go.kissmyapps.dev/fieldnote/ada'),
}

const FULL = 'https://go.kissmyapps.dev/the-very-long-named-language-learning-companion/ada-okafor'

/** Every custom link a program can have, some with the longest name a link can have. */
const full = {
  program_id: '00000000-0000-4000-8000-000000000005',
  slug: 'the-very-long-named-language-learning-companion',
  name: 'The Very Long Named Language Learning Companion for Busy People',
  currency: 'USD',
  working: true,
  paused_reason: null,
  custom_links: 20,
  links: [
    ...standardLinks(5, FULL, [1204381, 20114, 9051300], { tiktok: [88012, 1904, 856800] }),
    ...Array.from({ length: 20 }, (_, index) =>
      index % 5 === 0
        ? customLink(
            5,
            101 + index,
            `Autumn collaboration with partners no ${String(index + 1).padStart(2, '0')}`,
            `${FULL}/autumn-collaboration-with-partners-no-${String(index + 1).padStart(2, '0')}`,
            [index * 37, index, index * 450],
          )
        : customLink(5, 101 + index, `Video ${index + 1}`, `${FULL}/video-${index + 1}`, [
            index * 12,
            index % 3,
            (index % 3) * 450,
          ]),
    ),
  ],
}

const answer = (programs: unknown[]) => ({
  stats_days: 30,
  max_custom_links: 20,
  channels: CHANNELS,
  programs,
})

export const linksSampleFixture: Record<string, unknown> = {
  /** Three programs, ordered by name: one earning, one with an empty balance, one with results. */
  partner_program_links: answer([dramapal, loopHabits, speaksix]),
  /** One program, joined today. */
  partner_program_links_one: answer([fieldnote]),
  /** One program the brand has paused. */
  partner_program_links_paused: answer([
    { ...speaksix, working: false, paused_reason: 'program_paused' },
  ]),
  /** A program with every custom link it can have. */
  partner_program_links_full: answer([full]),
  /** A creator with no active membership. */
  partner_program_links_none: answer([]),
  /** SpeakSix after "Newsletter footer" was added. */
  partner_program_link_create: {
    ...speaksix,
    custom_links: 3,
    links: [
      ...speaksix.links,
      customLink(
        1,
        103,
        'Newsletter footer',
        `${SPEAKSIX}/newsletter-footer`,
        NOTHING,
        '2026-11-13T12:00:03.118220+00:00',
      ),
    ],
  },
  /** SpeakSix after "Bio link" was removed. */
  partner_program_link_remove: {
    ...speaksix,
    custom_links: 1,
    links: speaksix.links.filter((row) => row.name !== 'Bio link'),
  },
}
