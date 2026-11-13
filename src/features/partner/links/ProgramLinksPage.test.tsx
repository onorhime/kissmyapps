import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PartnerDataGateway } from '../api'
import { linksSampleFixture as backend } from './links.fixture'
import { LINK_NAME_MAX, linkError, readLinkProgram, readProgramLinks } from './links'
import type { LinkProgram, ProgramLinks, ProgramLinksErrorCode, ProgramLinksResult } from './links'
import { ProgramLinksPage } from './ProgramLinksPage'

// The answers ---------------------------------------------------------------------------------

const ok = <T,>(data: T): ProgramLinksResult<T | null> => ({ data, status: 'ready', error: null })

const failed = <T,>(code: ProgramLinksErrorCode): ProgramLinksResult<T | null> => ({
  data: null,
  status: 'error',
  error: linkError(code),
})

const links = (key = 'partner_program_links') => readProgramLinks(backend[key])

/** A gateway that only knows the link functions: the page calls nothing else. */
function gatewayWith(
  read: () => Promise<ProgramLinksResult<ProgramLinks | null>>,
  changes: Partial<Pick<PartnerDataGateway, 'createProgramLink' | 'removeProgramLink'>> = {},
) {
  const getProgramLinks = vi.fn(read)
  const gateway = { getProgramLinks, ...changes } as unknown as PartnerDataGateway
  return { gateway, getProgramLinks }
}

function gatewayAnswering(
  answer: ProgramLinksResult<ProgramLinks | null>,
  changes: Partial<Pick<PartnerDataGateway, 'createProgramLink' | 'removeProgramLink'>> = {},
) {
  return gatewayWith(async () => answer, changes)
}

/** The page with one program on it: SpeakSix, with a custom link that can be removed. */
function speaksixOnly(): ProgramLinks {
  const all = links()
  return { ...all, programs: all.programs.filter((program) => program.slug === 'speaksix') }
}

const speaksix = () => speaksixOnly().programs[0]

function clipboard() {
  return vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
}

const results = () => screen.getByRole('table', { name: 'Results by channel' })
const row = (name: string | RegExp) => within(results()).getByRole('row', { name })
const chips = () => screen.getByRole('list', { name: 'Copy for a channel' })

afterEach(() => {
  vi.useRealTimers()
})

// The page ------------------------------------------------------------------------------------

describe('the Links page with programs', () => {
  it('says it is loading until the answer is there', async () => {
    let finish: (value: ProgramLinksResult<ProgramLinks | null>) => void = () => {}
    const { gateway } = gatewayWith(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const { container } = render(<ProgramLinksPage gateway={gateway} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Links.' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your links')
    expect(container.querySelector('.pl-page')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    await act(async () => finish(ok(links())))
    expect(await screen.findByRole('table', { name: 'Results by channel' })).toBeInTheDocument()
    expect(container.querySelector('.pl-page')).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByText('Loading your links')).not.toBeInTheDocument()
  })

  it('shows the first program: its main link, a quiet Live, the channels and the results', async () => {
    const { gateway, getProgramLinks } = gatewayAnswering(ok(links()))
    const { container } = render(<ProgramLinksPage gateway={gateway} />)

    const first = links().programs[0]
    expect(
      await screen.findByRole('heading', { level: 2, name: `Your ${first.name} link` }),
    ).toBeInTheDocument()
    expect(getProgramLinks).toHaveBeenCalledOnce()
    expect(screen.getByText('Live')).toBeInTheDocument()
    // The whole address, without the scheme, never cut short.
    expect(container.querySelector('.pl-url')).toHaveTextContent(
      /^Main link: go\.kissmyapps\.dev\/dramapal\/ada$/,
    )
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeEnabled()

    expect(
      within(chips())
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual([
      'TikTok',
      'Instagram',
      'YouTube',
      'Facebook',
      'X',
      'Newsletter',
      'Add a custom link',
    ])

    expect(
      within(results())
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Channel', 'Link', 'Clicks', 'Sales', 'Conversion', 'Earnings'])
    expect(
      within(results())
        .getAllByRole('rowheader')
        .map((header) => header.textContent),
    ).toEqual(first.links.map((link) => link.name))
    expect(screen.getByText('Last 30 days')).toBeInTheDocument()
  })

  it('writes each row from the counts: money in normal units, a dash where there is no rate', async () => {
    const { gateway } = gatewayAnswering(ok(speaksixOnly()))
    render(<ProgramLinksPage gateway={gateway} />)
    await screen.findByRole('table', { name: 'Results by channel' })

    const cells = (name: string) =>
      within(row(new RegExp(`^${name} `)))
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    expect(cells('TikTok')).toEqual([
      'go.kissmyapps.dev/speaksix/ada/tiktok',
      '1,840',
      '46',
      '2.5%',
      '$276.00',
    ])
    expect(cells('Main link')).toEqual([
      'go.kissmyapps.dev/speaksix/ada',
      '58',
      '0',
      '0.0%',
      '$0.00',
    ])
    // No clicks: no rate. Never 0% and never NaN.
    expect(cells('Facebook')).toEqual([
      'go.kissmyapps.dev/speaksix/ada/facebook',
      '0',
      '0',
      '—',
      '$0.00',
    ])
    expect(results()).not.toHaveTextContent(/NaN|Infinity|undefined/)
    expect(results()).not.toHaveTextContent('27600')
  })

  it('writes money in the program’s own currency', async () => {
    const { gateway } = gatewayAnswering(ok(links()))
    const user = userEvent.setup()
    render(<ProgramLinksPage gateway={gateway} />)
    await user.click(await screen.findByRole('button', { name: 'Loop Habits' }))
    expect(within(row(/^Main link /)).getByText('12.00 EUR')).toBeInTheDocument()
  })

  it('offers no picker with one program', async () => {
    const { gateway } = gatewayAnswering(ok(links('partner_program_links_one')))
    render(<ProgramLinksPage gateway={gateway} />)
    await screen.findByRole('heading', { name: 'Your Fieldnote link' })
    expect(screen.queryByRole('group', { name: 'Program' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Program' })).not.toBeInTheDocument()
  })

  it('leaves out a channel the program has no link for', async () => {
    const all = speaksixOnly()
    const program = all.programs[0]
    const { gateway } = gatewayAnswering(
      ok({
        ...all,
        programs: [
          { ...program, links: program.links.filter((link) => link.channel !== 'facebook') },
        ],
      }),
    )
    render(<ProgramLinksPage gateway={gateway} />)
    await screen.findByRole('table', { name: 'Results by channel' })

    expect(all.channels.map((channel) => channel.key)).toContain('facebook')
    expect(within(chips()).queryByRole('button', { name: 'Facebook' })).not.toBeInTheDocument()
    expect(within(results()).queryByRole('rowheader', { name: 'Facebook' })).not.toBeInTheDocument()
    expect(within(chips()).getByRole('button', { name: 'Instagram' })).toBeInTheDocument()
    expect(within(results()).getAllByRole('rowheader')).toHaveLength(program.links.length - 1)
  })

  it('switches program from the picker', async () => {
    const { gateway, getProgramLinks } = gatewayAnswering(ok(links()))
    const user = userEvent.setup()
    const { container } = render(<ProgramLinksPage gateway={gateway} />)

    const picker = await screen.findByRole('group', { name: 'Program' })
    const names = links().programs.map((program) => program.name)
    expect(
      within(picker)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(names)
    expect(within(picker).getByRole('button', { name: names[0] })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(within(picker).getByRole('button', { name: 'SpeakSix' }))
    expect(screen.getByRole('heading', { name: 'Your SpeakSix link' })).toBeInTheDocument()
    expect(within(picker).getByRole('button', { name: 'SpeakSix' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(picker).getByRole('button', { name: names[0] })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(container.querySelector('.pl-url')).toHaveTextContent(
      /^Main link: go\.kissmyapps\.dev\/speaksix\/ada$/,
    )
    expect(within(chips()).getByRole('button', { name: 'Podcast' })).toBeInTheDocument()
    // Picking a program reads nothing again: the answer has every program in it.
    expect(getProgramLinks).toHaveBeenCalledOnce()
  })

  it('picks from a list when there are too many programs for buttons', async () => {
    const base = links()
    const many: ProgramLinks = {
      ...base,
      programs: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((name, index) => ({
        ...base.programs[0],
        program_id: `prog-${index}`,
        slug: name.toLowerCase(),
        name,
      })),
    }
    const { gateway } = gatewayAnswering(ok(many))
    const user = userEvent.setup()
    render(<ProgramLinksPage gateway={gateway} />)

    const picker = await screen.findByRole('combobox', { name: 'Program' })
    expect(within(picker).getAllByRole('option')).toHaveLength(5)
    expect(screen.queryByRole('group', { name: 'Program' })).not.toBeInTheDocument()
    await user.selectOptions(picker, 'Delta')
    expect(screen.getByRole('heading', { name: 'Your Delta link' })).toBeInTheDocument()
  })
})

describe('copying a link', () => {
  it('copies the main link in full and says so', async () => {
    const { gateway } = gatewayAnswering(ok(speaksixOnly()))
    const user = userEvent.setup()
    const writeText = clipboard()
    render(<ProgramLinksPage gateway={gateway} />)

    await user.click(await screen.findByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('https://go.kissmyapps.dev/speaksix/ada')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(screen.getByText('Main link copied')).toHaveAttribute('role', 'status')
    expect(within(chips()).queryByText('copied')).not.toBeInTheDocument()
  })

  it('copies a channel’s own address from its chip and confirms with "copied"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { gateway } = gatewayAnswering(ok(speaksixOnly()))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const writeText = clipboard()
    render(<ProgramLinksPage gateway={gateway} />)

    await screen.findByRole('table', { name: 'Results by channel' })
    await user.click(within(chips()).getByRole('button', { name: 'TikTok' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      'https://go.kissmyapps.dev/speaksix/ada/tiktok',
    )
    expect(await within(chips()).findByRole('button', { name: 'TikTok copied' })).toBeVisible()
    expect(screen.getByText('TikTok copied', { selector: '[role="status"]' })).toBeInTheDocument()
    // Only the one that was pressed says so, and the main button does not.
    expect(within(chips()).getAllByText('copied')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()

    await user.click(within(chips()).getByRole('button', { name: 'Podcast' }))
    expect(writeText).toHaveBeenLastCalledWith('https://go.kissmyapps.dev/speaksix/ada/podcast')
    expect(await within(chips()).findByRole('button', { name: 'Podcast copied' })).toBeVisible()
    expect(within(chips()).getByRole('button', { name: 'TikTok' })).toBeInTheDocument()

    // The word goes away by itself.
    await act(async () => {
      vi.advanceTimersByTime(4100)
    })
    expect(within(chips()).queryByText('copied')).not.toBeInTheDocument()
    expect(within(chips()).getByRole('button', { name: 'Podcast' })).toBeInTheDocument()
  })

  it('hands over the address to copy by hand when the clipboard refuses', async () => {
    const { gateway } = gatewayAnswering(ok(speaksixOnly()))
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    render(<ProgramLinksPage gateway={gateway} />)

    await screen.findByRole('table', { name: 'Results by channel' })
    await user.click(within(chips()).getByRole('button', { name: 'Instagram' }))
    const note = await screen.findByText(/Copying did not work here/)
    expect(note).toHaveAttribute('role', 'status')
    expect(note).toHaveTextContent(
      'Select the Instagram link and copy it: https://go.kissmyapps.dev/speaksix/ada/instagram',
    )
    expect(within(chips()).queryByText('copied')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument()
  })

  it('still copies while a program is paused', async () => {
    const { gateway } = gatewayAnswering(ok(links('partner_program_links_paused')))
    const user = userEvent.setup()
    const writeText = clipboard()
    render(<ProgramLinksPage gateway={gateway} />)
    await user.click(await screen.findByRole('button', { name: 'Copy link' }))
    expect(writeText).toHaveBeenCalledOnce()
  })
})

describe('a paused program', () => {
  it('says the brand paused it, in one sentence, in place of Live', async () => {
    const { gateway } = gatewayAnswering(ok(links('partner_program_links_paused')))
    render(<ProgramLinksPage gateway={gateway} />)
    expect(
      await screen.findByText('Paused by the brand: sales are not credited right now.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Live')).not.toBeInTheDocument()
    // The links and their results are still there.
    expect(results()).toBeInTheDocument()
    expect(within(chips()).getByRole('button', { name: 'TikTok' })).toBeEnabled()
  })

  it('says the balance is empty when that is why', async () => {
    const { gateway } = gatewayAnswering(ok(links()))
    const user = userEvent.setup()
    render(<ProgramLinksPage gateway={gateway} />)
    await user.click(await screen.findByRole('button', { name: 'Loop Habits' }))
    expect(
      screen.getByText(
        'Paused: the brand’s balance is empty, so sales are not credited right now.',
      ),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'SpeakSix' }))
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.queryByText(/Paused/)).not.toBeInTheDocument()
  })
})

describe('adding a custom link', () => {
  function adding(
    createProgramLink: PartnerDataGateway['createProgramLink'] = vi.fn(async () =>
      ok(readLinkProgram(backend.partner_program_link_create)),
    ),
  ) {
    const { gateway, getProgramLinks } = gatewayAnswering(ok(speaksixOnly()), {
      createProgramLink,
    })
    const user = userEvent.setup()
    render(<ProgramLinksPage gateway={gateway} />)
    return { user, createProgramLink: createProgramLink!, getProgramLinks }
  }

  async function openForm(user: ReturnType<typeof userEvent.setup>) {
    const chip = await screen.findByRole('button', { name: 'Add a custom link' })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await user.click(chip)
    return screen.getByRole('textbox', { name: 'Name of the link' })
  }

  it('opens one field and one button under the chips, and says how many are used', async () => {
    const { user } = adding()
    const field = await openForm(user)

    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('maxlength', '40')
    expect(screen.getByRole('button', { name: 'Add a custom link' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Add link' })).toBeEnabled()
    expect(field).toHaveAccessibleDescription(/2 of 20 custom links used/)
  })

  it('adds the link, shows it as a chip and a row, and moves to the new chip', async () => {
    const { user, createProgramLink, getProgramLinks } = adding()
    const field = await openForm(user)

    await user.type(field, '  Newsletter footer  ')
    await user.click(screen.getByRole('button', { name: 'Add link' }))

    expect(createProgramLink).toHaveBeenCalledExactlyOnceWith({
      slug: 'speaksix',
      name: 'Newsletter footer',
    })
    const chip = await within(chips()).findByRole('button', { name: 'Newsletter footer' })
    await waitFor(() => expect(chip).toHaveFocus())
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a custom link' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(row(/^Newsletter footer /)).toHaveTextContent(
      'go.kissmyapps.dev/speaksix/ada/newsletter-footer',
    )
    expect(screen.getByText('Newsletter footer added')).toHaveAttribute('role', 'status')
    // The answer of the change is the program as it is now: nothing is read again.
    expect(getProgramLinks).toHaveBeenCalledOnce()

    // And it copies like any other.
    const writeText = clipboard()
    await user.click(chip)
    expect(writeText).toHaveBeenCalledWith(
      'https://go.kissmyapps.dev/speaksix/ada/newsletter-footer',
    )
  })

  it('adds with the Enter key', async () => {
    const { user, createProgramLink } = adding()
    await user.type(await openForm(user), 'Newsletter footer{Enter}')
    expect(createProgramLink).toHaveBeenCalledOnce()
    expect(await within(chips()).findByRole('button', { name: 'Newsletter footer' })).toBeVisible()
  })

  it('asks for a name, and refuses one that is taken, before anything is sent', async () => {
    const { user, createProgramLink } = adding()
    const field = await openForm(user)

    await user.click(screen.getByRole('button', { name: 'Add link' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Give the link a name.')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveFocus()
    expect(field).toHaveAccessibleDescription(/Give the link a name\./)

    for (const taken of ['tiktok', 'Main link', 'PODCAST']) {
      await user.clear(field)
      await user.type(field, taken)
      await user.click(screen.getByRole('button', { name: 'Add link' }))
      expect(screen.getByRole('alert')).toHaveTextContent(
        'You already have a link with that name. Pick another name.',
      )
    }
    expect(createProgramLink).not.toHaveBeenCalled()

    // A good name clears the complaint.
    await user.clear(field)
    await user.type(field, 'Newsletter footer')
    await user.click(screen.getByRole('button', { name: 'Add link' }))
    await within(chips()).findByRole('button', { name: 'Newsletter footer' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each([
    ['invalid_input', 'That could not be sent. Reload the page and try again.'],
    ['invalid_name', 'Use a name of 1 to 40 characters.'],
    ['name_taken', 'You already have a link with that name. Pick another name.'],
    ['too_many_links', 'This program has all the custom links it can have.'],
    ['not_member', 'You are no longer a member of this program.'],
    ['not_authorized', 'Your role on this creator account cannot change links.'],
    ['not_authenticated', 'Your session has expired. Sign in again to continue.'],
    ['temporarily_unavailable', 'That did not go through. Check your connection and try again.'],
    ['invalid_response', 'The answer could not be read. Try again.'],
    ['unknown', 'That did not go through. Try again.'],
  ] as const)('says what %s means and keeps what was typed', async (code, sentence) => {
    const { user } = adding(vi.fn(async () => failed<LinkProgram>(code)))
    const field = await openForm(user)
    await user.type(field, 'Bio two')
    await user.click(screen.getByRole('button', { name: 'Add link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(sentence)
    expect(screen.getByRole('alert').textContent).not.toMatch(/_/)
    expect(field).toHaveValue('Bio two')
    expect(field).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Add link' })).toBeEnabled()
    expect(within(chips()).queryByRole('button', { name: 'Bio two' })).not.toBeInTheDocument()
  })

  it('reads the page again when the answer shows it was out of date', async () => {
    const { user, getProgramLinks } = adding(vi.fn(async () => failed<LinkProgram>('name_taken')))
    await user.type(await openForm(user), 'Bio two{Enter}')
    await screen.findByRole('alert')
    await waitFor(() => expect(getProgramLinks).toHaveBeenCalledTimes(2))
    // What was typed and what went wrong are still on the page.
    expect(screen.getByRole('textbox', { name: 'Name of the link' })).toHaveValue('Bio two')
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('does not read again after a failure that says nothing about the page', async () => {
    const { user, getProgramLinks } = adding(
      vi.fn(async () => failed<LinkProgram>('temporarily_unavailable')),
    )
    await user.type(await openForm(user), 'Bio two{Enter}')
    await screen.findByRole('alert')
    expect(getProgramLinks).toHaveBeenCalledOnce()
  })

  it('cannot be sent twice while it is being added', async () => {
    let finish: (value: ProgramLinksResult<LinkProgram | null>) => void = () => {}
    const createProgramLink = vi.fn(
      () =>
        new Promise<ProgramLinksResult<LinkProgram | null>>((resolve) => {
          finish = resolve
        }),
    )
    const { user } = adding(createProgramLink)
    const field = await openForm(user)
    await user.type(field, 'Newsletter footer{Enter}')

    const button = await screen.findByRole('button', { name: 'Adding' })
    expect(button).toBeDisabled()
    expect(field).toHaveAttribute('readonly')
    await user.type(field, '{Enter}')
    await user.keyboard('{Escape}')
    expect(createProgramLink).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox', { name: 'Name of the link' })).toBeInTheDocument()

    await act(async () => finish(ok(readLinkProgram(backend.partner_program_link_create))))
    expect(await within(chips()).findByRole('button', { name: 'Newsletter footer' })).toBeVisible()
  })

  it('answers a call that throws as something to try again', async () => {
    const { user } = adding(
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await user.type(await openForm(user), 'Bio two{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That did not go through. Check your connection and try again.',
    )
  })

  it('closes with Escape or the chip, and gives the focus back to the chip', async () => {
    const { user, createProgramLink } = adding()
    await user.type(await openForm(user), 'Half a name')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    const chip = screen.getByRole('button', { name: 'Add a custom link' })
    expect(chip).toHaveFocus()
    expect(chip).toHaveAttribute('aria-expanded', 'false')

    await user.click(chip)
    // Opened again, the field starts empty.
    expect(screen.getByRole('textbox', { name: 'Name of the link' })).toHaveValue('')
    await user.click(chip)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(createProgramLink).not.toHaveBeenCalled()
  })

  it('offers no more links once the program has all it can have', async () => {
    const { gateway } = gatewayAnswering(ok(links('partner_program_links_full')))
    render(<ProgramLinksPage gateway={gateway} />)
    await screen.findByRole('table', { name: 'Results by channel' })

    expect(screen.queryByRole('button', { name: 'Add a custom link' })).not.toBeInTheDocument()
    expect(
      within(chips()).getByText('20 of 20 custom links used. That is the most a program can have.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})

describe('removing a custom link', () => {
  function removing(
    removeProgramLink: PartnerDataGateway['removeProgramLink'] = vi.fn(async () =>
      ok(readLinkProgram(backend.partner_program_link_remove)),
    ),
  ) {
    const { gateway, getProgramLinks } = gatewayAnswering(ok(speaksixOnly()), {
      removeProgramLink,
    })
    const user = userEvent.setup()
    render(<ProgramLinksPage gateway={gateway} />)
    return { user, removeProgramLink: removeProgramLink!, getProgramLinks }
  }

  const bioLink = () => speaksix().links.find((link) => link.name === 'Bio link')!

  it('offers Remove only on a custom link that nobody has clicked', async () => {
    removing()
    await screen.findByRole('table', { name: 'Results by channel' })

    const removable = speaksix().links.filter((link) => link.removable)
    expect(removable.map((link) => link.name)).toEqual(['Bio link'])
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1)
    expect(within(row(/^Bio link /)).getByRole('button', { name: 'Remove Bio link' })).toBeEnabled()
    for (const name of ['Main link', 'TikTok', 'Podcast'])
      expect(within(row(new RegExp(`^${name} `))).queryByRole('button')).not.toBeInTheDocument()
  })

  it('asks first, and keeps the link when the answer is Keep', async () => {
    const { user, removeProgramLink } = removing()
    await user.click(await screen.findByRole('button', { name: 'Remove Bio link' }))

    const question = screen.getByRole('group', { name: 'Remove Bio link?' })
    expect(within(question).getByRole('button', { name: 'Yes, remove' })).toHaveFocus()
    await user.click(within(question).getByRole('button', { name: 'Keep' }))

    expect(screen.queryByRole('group', { name: 'Remove Bio link?' })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove Bio link' })).toHaveFocus(),
    )
    expect(removeProgramLink).not.toHaveBeenCalled()

    // Escape answers Keep too.
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Yes, remove' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove Bio link' })).toHaveFocus(),
    )
    expect(removeProgramLink).not.toHaveBeenCalled()
    expect(row(/^Bio link /)).toBeInTheDocument()
  })

  it('removes the link: its row and its chip go, and the focus stays on the results', async () => {
    const { user, removeProgramLink, getProgramLinks } = removing()
    await user.click(await screen.findByRole('button', { name: 'Remove Bio link' }))
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }))

    expect(removeProgramLink).toHaveBeenCalledExactlyOnceWith(bioLink().link_id)
    await waitFor(() =>
      expect(within(results()).queryByRole('row', { name: /^Bio link / })).not.toBeInTheDocument(),
    )
    expect(within(chips()).queryByRole('button', { name: 'Bio link' })).not.toBeInTheDocument()
    expect(row(/^Podcast /)).toBeInTheDocument()
    expect(screen.getByText('Bio link removed')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('heading', { name: 'Results by channel' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getProgramLinks).toHaveBeenCalledOnce()
  })

  it('cannot be sent twice while it is being removed', async () => {
    let finish: (value: ProgramLinksResult<LinkProgram | null>) => void = () => {}
    const removeProgramLink = vi.fn(
      () =>
        new Promise<ProgramLinksResult<LinkProgram | null>>((resolve) => {
          finish = resolve
        }),
    )
    const { user } = removing(removeProgramLink)
    await user.click(await screen.findByRole('button', { name: 'Remove Bio link' }))
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }))

    expect(await screen.findByRole('button', { name: 'Removing' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep' })).toBeDisabled()
    expect(removeProgramLink).toHaveBeenCalledOnce()
    await act(async () => finish(ok(readLinkProgram(backend.partner_program_link_remove))))
    await waitFor(() =>
      expect(within(results()).queryByRole('row', { name: /^Bio link / })).not.toBeInTheDocument(),
    )
  })

  it.each([
    ['link_in_use', 'Bio link: This link has been opened, so it stays.', 2],
    ['not_removable', 'Bio link: This link cannot be removed.', 2],
    ['link_not_found', 'Bio link: This link is no longer there.', 2],
    ['invalid_input', 'Bio link: That could not be sent. Reload the page and try again.', 1],
    ['not_authorized', 'Bio link: Your role on this creator account cannot change links.', 1],
    [
      'temporarily_unavailable',
      'Bio link: That did not go through. Check your connection and try again.',
      1,
    ],
  ] as const)(
    'says what %s means and leaves the link where it is',
    async (code, sentence, reads) => {
      const { user, getProgramLinks } = removing(vi.fn(async () => failed<LinkProgram>(code)))
      await user.click(await screen.findByRole('button', { name: 'Remove Bio link' }))
      await user.click(screen.getByRole('button', { name: 'Yes, remove' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(sentence)
      expect(screen.getByRole('alert').textContent).not.toMatch(/_/)
      expect(row(/^Bio link /)).toBeInTheDocument()
      expect(screen.queryByRole('group', { name: 'Remove Bio link?' })).not.toBeInTheDocument()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Remove Bio link' })).toHaveFocus(),
      )
      // Out of date: read again. Otherwise not.
      await waitFor(() => expect(getProgramLinks).toHaveBeenCalledTimes(reads))

      // Asking again clears what went wrong.
      await user.click(screen.getByRole('button', { name: 'Remove Bio link' }))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )

  it('shows the link has clicks now once the page was read again', async () => {
    const clicked: ProgramLinks = {
      ...speaksixOnly(),
      programs: [
        {
          ...speaksix(),
          links: speaksix().links.map((link) =>
            link.name === 'Bio link' ? { ...link, clicks: 3, removable: false } : link,
          ),
        },
      ],
    }
    const read = vi
      .fn<() => Promise<ProgramLinksResult<ProgramLinks | null>>>()
      .mockResolvedValueOnce(ok(speaksixOnly()))
      .mockResolvedValue(ok(clicked))
    const gateway = {
      getProgramLinks: read,
      removeProgramLink: vi.fn(async () => failed<LinkProgram>('link_in_use')),
    } as unknown as PartnerDataGateway
    const user = userEvent.setup()
    render(<ProgramLinksPage gateway={gateway} />)

    await user.click(await screen.findByRole('button', { name: 'Remove Bio link' }))
    await user.click(screen.getByRole('button', { name: 'Yes, remove' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove Bio link' })).not.toBeInTheDocument(),
    )
    expect(within(row(/^Bio link /)).getByText('3')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('This link has been opened, so it stays.')
  })
})

describe('many links and long names', () => {
  it('shows every link of a program that has all its custom links', async () => {
    const full = links('partner_program_links_full').programs[0]
    const { gateway } = gatewayAnswering(ok(links('partner_program_links_full')))
    const { container } = render(<ProgramLinksPage gateway={gateway} />)
    await screen.findByRole('table', { name: 'Results by channel' })

    expect(full.links).toHaveLength(27)
    expect(within(results()).getAllByRole('rowheader')).toHaveLength(27)
    expect(within(chips()).getAllByRole('button')).toHaveLength(26)
    // The program's whole name and whole address are on the page, however long.
    expect(screen.getByRole('heading', { name: `Your ${full.name} link` })).toBeInTheDocument()
    expect(container.querySelector('.pl-url')).toHaveTextContent(
      full.links[0].url.replace('https://', ''),
    )

    // A name of forty characters is whole in its row, and whole to a pointer on its chip.
    const longest = full.links.find((link) => link.name.length === LINK_NAME_MAX)!
    expect(within(results()).getByRole('rowheader', { name: longest.name })).toBeInTheDocument()
    expect(within(chips()).getByRole('button', { name: longest.name })).toHaveAttribute(
      'title',
      longest.name,
    )
    // Large numbers are grouped, and money stays in normal units.
    expect(within(row(/^Main link /)).getByText('1,204,381')).toBeInTheDocument()
    expect(within(row(/^Main link /)).getByText('$90,513.00')).toBeInTheDocument()
  })
})

describe('the Links page with nothing to show', () => {
  it('says to join a program, with a link to the marketplace', async () => {
    const { gateway } = gatewayAnswering(ok(links('partner_program_links_none')))
    render(<ProgramLinksPage gateway={gateway} />)

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Join a program to get your link' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the marketplace' })).toHaveAttribute(
      'href',
      '#marketplace',
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Links.' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says the links did not load and reads again on Try again', async () => {
    const read = vi
      .fn<() => Promise<ProgramLinksResult<ProgramLinks | null>>>()
      .mockResolvedValueOnce(failed('temporarily_unavailable'))
      .mockResolvedValue(ok(links()))
    const gateway = { getProgramLinks: read } as unknown as PartnerDataGateway
    const user = userEvent.setup()
    render(<ProgramLinksPage gateway={gateway} />)

    const problem = await screen.findByRole('alert')
    expect(within(problem).getByRole('heading', { name: 'Your links did not load' })).toBeVisible()
    expect(problem).toHaveTextContent(
      'That did not go through. Check your connection and try again.',
    )
    await user.click(within(problem).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('table', { name: 'Results by channel' })).toBeInTheDocument()
    expect(read).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refuses an answer it cannot read, in plain words', async () => {
    const { gateway } = gatewayAnswering(failed('invalid_response'))
    render(<ProgramLinksPage gateway={gateway} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The answer could not be read. Try again.',
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })

  it('answers a read that throws as something to try again', async () => {
    const { gateway } = gatewayWith(async () => {
      throw new TypeError('Failed to fetch')
    })
    render(<ProgramLinksPage gateway={gateway} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That did not go through. Check your connection and try again.',
    )
  })

  it('offers no retry to someone whose session has ended', async () => {
    const { gateway } = gatewayAnswering(failed('not_authenticated'))
    render(<ProgramLinksPage gateway={gateway} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your session has expired. Sign in again to continue.',
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it.each([
    ['contract_unavailable', 'Links are not available yet.'],
    ['not_configured', 'Links are not available yet.'],
    ['not_authorized', 'Your creator account is not active, so links are not available to it.'],
  ] as const)('says so quietly when links are not there (%s)', async (code, sentence) => {
    const { gateway } = gatewayAnswering(failed(code))
    render(<ProgramLinksPage gateway={gateway} />)
    expect(await screen.findByText(sentence)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('says links are not there on a deployment whose gateway has no link functions', async () => {
    render(<ProgramLinksPage gateway={{} as PartnerDataGateway} />)
    expect(await screen.findByText('Links are not available yet.')).toBeInTheDocument()
  })

  it('shows nothing at all above the older links when links are not there', async () => {
    const { gateway, getProgramLinks } = gatewayAnswering(failed('contract_unavailable'))
    const { container } = render(<ProgramLinksPage gateway={gateway} legacyBelow />)
    await waitFor(() => expect(getProgramLinks).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})

describe('the Links page above the older links', () => {
  it('is titled Program links, so the two titles on the page differ', async () => {
    const { gateway } = gatewayAnswering(ok(links()))
    render(<ProgramLinksPage gateway={gateway} legacyBelow />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Program links.' })).toBeVisible()
    expect(screen.queryByRole('heading', { level: 1, name: 'Links.' })).not.toBeInTheDocument()
  })
})

describe('the Links page as a whole', () => {
  it('has no accessibility violations with results, a paused program and the form open', async () => {
    const { gateway } = gatewayAnswering(ok(links()))
    const user = userEvent.setup()
    const view = render(<ProgramLinksPage gateway={gateway} />)
    await user.click(await screen.findByRole('button', { name: 'SpeakSix' }))
    await user.click(screen.getByRole('button', { name: 'Add a custom link' }))
    await user.click(screen.getByRole('button', { name: 'Add link' }))
    await user.click(screen.getByRole('button', { name: 'Remove Bio link' }))
    for (const program of ['SpeakSix', 'Loop Habits']) {
      await user.click(screen.getByRole('button', { name: program }))
      const found = await axe.run(view.container, {
        rules: { 'color-contrast': { enabled: false } },
      })
      expect(found.violations).toEqual([])
    }
  })

  it('has no accessibility violations with no program and with a failure', async () => {
    for (const answer of [
      ok(links('partner_program_links_none')),
      failed<ProgramLinks>('temporarily_unavailable'),
    ]) {
      const { gateway } = gatewayAnswering(answer)
      const view = render(<ProgramLinksPage gateway={gateway} />)
      await waitFor(() =>
        expect(view.container.querySelector('.pl-page')).toHaveAttribute('aria-busy', 'false'),
      )
      const found = await axe.run(view.container, {
        rules: { 'color-contrast': { enabled: false } },
      })
      expect(found.violations).toEqual([])
      view.unmount()
    }
  })

  it('never speaks of a test mode, of minor units or of buyers', async () => {
    for (const key of [
      'partner_program_links',
      'partner_program_links_one',
      'partner_program_links_paused',
      'partner_program_links_full',
      'partner_program_links_none',
    ]) {
      const { gateway } = gatewayAnswering(ok(links(key)))
      const view = render(<ProgramLinksPage gateway={gateway} />)
      await waitFor(() =>
        expect(view.container.querySelector('.pl-page')).toHaveAttribute('aria-busy', 'false'),
      )
      expect(view.container.textContent).not.toMatch(/test mode|sandbox|minor|cents|@|buyer/i)
      view.unmount()
    }
  })
})
