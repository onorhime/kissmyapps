// Sample answers of `partner_program_links` for programs that pay for events, written by hand
// to the shape in the Phase 6 contract (Piece 3, item 2): each link gains `events`, and each
// program gains `earn_from`. Fluent pays for events, Loop Habits for sales and events, SpeakSix
// for sales. To be joined by output captured from the database.
import { linksSampleFixture } from './links.fixture'

const CHANNELS = [
  { key: 'tiktok', name: 'TikTok' },
  { key: 'instagram', name: 'Instagram' },
  { key: 'youtube', name: 'YouTube' },
  { key: 'facebook', name: 'Facebook' },
  { key: 'x', name: 'X' },
  { key: 'newsletter', name: 'Newsletter' },
]

type Counts = [clicks: number, sales: number, events: number, earningsMinor: number]

const NOTHING: Counts = [0, 0, 0, 0]

function link(
  programNumber: number,
  linkNumber: number,
  kind: 'main' | 'channel' | 'custom',
  name: string,
  url: string,
  [clicks, sales, events, earningsMinor]: Counts,
  extra: Record<string, unknown> = {},
) {
  return {
    link_id: `00000000-0000-4000-8000-${String(programNumber).padStart(4, '0')}${String(linkNumber).padStart(8, '0')}`,
    kind,
    channel: null,
    name,
    url,
    created_at: '2026-11-02T09:14:07.512846+00:00',
    clicks,
    sales,
    events,
    earnings_minor: earningsMinor,
    removable: false,
    ...extra,
  }
}

/** The main link and the six channel links every member has. */
function standardLinks(
  programNumber: number,
  base: string,
  main: Counts,
  channels: Partial<Record<string, Counts>>,
) {
  return [
    link(programNumber, 0, 'main', 'Main link', base, main),
    ...CHANNELS.map((channel, index) =>
      link(
        programNumber,
        index + 1,
        'channel',
        channel.name,
        `${base}/${channel.key}`,
        channels[channel.key] ?? NOTHING,
        { channel: channel.key },
      ),
    ),
  ]
}

const FLUENT = 'https://go.kissmyapps.dev/fluent/ada'

/** Pays $2.00 for an account created and $5.00 for a trial started. No sale earns anything. */
const fluent = {
  program_id: '00000000-0000-4000-8000-000000000006',
  slug: 'fluent',
  name: 'Fluent',
  currency: 'USD',
  earn_from: 'events',
  working: true,
  paused_reason: null,
  custom_links: 2,
  links: [
    ...standardLinks(6, FLUENT, [74, 0, 2, 400], {
      tiktok: [1060, 0, 100, 27300],
      instagram: [512, 0, 41, 11800],
      youtube: [236, 0, 22, 7100],
      newsletter: [88, 0, 12, 3900],
    }),
    link(6, 101, 'custom', 'Podcast', `${FLUENT}/podcast`, [143, 0, 9, 2400], {
      created_at: '2026-11-04T10:02:55.330912+00:00',
    }),
    link(6, 102, 'custom', 'Bio link', `${FLUENT}/bio-link`, NOTHING, {
      created_at: '2026-11-06T16:40:21.090114+00:00',
      removable: true,
    }),
  ],
}

/** Pays a commission on sales and $1.50 for an account created. */
const loopHabits = {
  program_id: '00000000-0000-4000-8000-000000000003',
  slug: 'loop-habits',
  name: 'Loop Habits',
  currency: 'USD',
  earn_from: 'both',
  working: true,
  paused_reason: null,
  custom_links: 0,
  links: standardLinks(3, 'https://go.kissmyapps.dev/loop-habits/ada', [41, 0, 3, 450], {
    tiktok: [612, 11, 58, 18600],
    instagram: [318, 6, 29, 9750],
    youtube: [127, 3, 11, 4350],
    x: [36, 0, 0, 0],
  }),
}

/** The programs of the Phase 5 sample, as a Phase 6 database sends a program that pays for sales. */
const salesPrograms = (linksSampleFixture.partner_program_links as { programs: unknown[] }).programs
  .map((program) => program as { links: Record<string, unknown>[] })
  .map((program) => ({
    ...program,
    earn_from: 'sales',
    links: program.links.map((row) => ({ ...row, events: 0 })),
  }))

const answer = (programs: unknown[]) => ({
  stats_days: 30,
  max_custom_links: 20,
  channels: CHANNELS,
  programs,
})

export const linksEventsFixture: Record<string, unknown> = {
  /** One program that pays for events. */
  events_program: answer([fluent]),
  /** One program that pays for sales and for events. */
  both_program: answer([loopHabits]),
  /** A creator in one program of each kind, ordered by name. */
  mixed: answer([fluent, loopHabits, salesPrograms[2]]),
  /** A program that pays for events, paused by the brand. */
  events_paused: answer([{ ...fluent, working: false, paused_reason: 'program_paused' }]),
  /** A program that pays for both, with an empty balance. */
  both_balance_empty: answer([{ ...loopHabits, working: false, paused_reason: 'balance_empty' }]),
  /** The Phase 5 sample, with the keys every Phase 6 answer carries and nothing in them. */
  sales_programs: answer(salesPrograms),
}
