import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { JourneyDefinitionEditor } from './JourneyDefinitionEditor'
import type { JourneyDefinitionConfiguration } from '../journeyDefinitions'
import type { FunnelMetricsGateway, FunnelMetricsResult } from '../types'

const ready = <T,>(data: T): FunnelMetricsResult<T> => ({ status: 'ready', data, error: null })
const configuration = (funnelId = 'saas-funnel'): JourneyDefinitionConfiguration => ({
  funnelId,
  draft: {
    revision: 4,
    template: 'custom',
    definition: {
      stages: [
        { key: 'trial', label: 'Trial users', source: 'event', eventNames: ['trial_started'] },
        {
          key: 'activated',
          label: 'Activated workspaces',
          source: 'event',
          eventNames: ['workspace_activated'],
        },
        { key: 'paid', label: 'Customers', source: 'purchase' },
      ],
      rates: [{ key: 'activation_rate', label: 'Trial activation', steps: ['trial', 'activated'] }],
      paths: [
        {
          key: 'trial_purchase',
          label: 'Trial → activation → purchase',
          steps: ['trial', 'activated', 'paid'],
        },
      ],
    },
  },
  published: null,
  versions: [],
})
function gateway(initial = configuration()): FunnelMetricsGateway {
  let saved = initial
  return {
    getJourneyDefinition: vi.fn(async (funnelId) => ready({ ...saved, funnelId })),
    saveJourneyDefinition: vi.fn(async (input) => {
      saved = {
        ...saved,
        funnelId: input.funnelId,
        draft: {
          revision: input.expectedRevision + 1,
          template: input.template,
          definition: input.definition,
        },
      }
      return ready(saved)
    }),
    publishJourneyDefinition: vi.fn(async (input) => {
      const version = (saved.published?.version ?? 0) + 1
      const publishedAt = '2026-10-22T16:00:00Z'
      saved = {
        ...saved,
        draft: { ...saved.draft, revision: input.expectedRevision + 1 },
        published: { version, publishedAt, definition: saved.draft.definition },
        versions: [...saved.versions, { version, publishedAt }],
      }
      return ready(saved)
    }),
    getConfiguration: vi.fn(),
    saveDraft: vi.fn(),
    publish: vi.fn(),
    validateEvent: vi.fn(),
    preview: vi.fn(),
    getAdminReport: vi.fn(),
    getReport: vi.fn(),
  }
}
const stage = (number: number) =>
  within(screen.getByRole('region', { name: `Journey stage ${number}` }))
const props = { funnelId: 'saas-funnel', canManage: true }
const failure = (
  code: 'conflict' | 'unavailable',
): FunnelMetricsResult<JourneyDefinitionConfiguration> => ({
  status: 'error',
  data: null,
  error: {
    code,
    retryable: code === 'unavailable',
    message:
      code === 'conflict'
        ? 'This journey was changed in another tab. Reload first.'
        : 'Network unavailable. Your edits remain.',
  },
})

describe('product-owned journey definition editor', () => {
  it('saves a new blank revision-zero draft before enabling publication', async () => {
    const initial = configuration()
    initial.draft = {
      revision: 0,
      template: 'blank',
      definition: { stages: [], rates: [], paths: [] },
    }
    const api = gateway(initial),
      user = userEvent.setup()
    render(<JourneyDefinitionEditor {...props} gateway={api} />)
    await screen.findByText('No journey published · Draft revision 0')
    expect(screen.getByRole('button', { name: 'Save journey draft' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Publish journey version' })).toBeDisabled()
    expect(screen.getByText(/Save this new journey draft first/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Publish journey version' }))
    expect(api.publishJourneyDefinition).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Save journey draft' }))
    await screen.findByText(/Journey draft saved/)
    expect(api.saveJourneyDefinition).toHaveBeenCalledWith({
      funnelId: 'saas-funnel',
      expectedRevision: 0,
      template: 'blank',
      definition: { stages: [], rates: [], paths: [] },
    })
    expect(screen.getByRole('button', { name: 'Save journey draft' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Publish journey version' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Publish journey version' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish journey' }),
    )
    await screen.findByText(/Journey version 1 published/)
    expect(api.publishJourneyDefinition).toHaveBeenCalledWith({
      funnelId: 'saas-funnel',
      expectedRevision: 1,
    })
  })
  it('loads a non-webinar product without adding hidden stages or changing its saved configuration', async () => {
    const api = gateway()
    render(<JourneyDefinitionEditor {...props} gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    expect(stage(1).getByLabelText('Stage name')).toHaveValue('Trial users')
    expect(screen.queryByDisplayValue('Webinar registrations')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('webinar_registered')).not.toBeInTheDocument()
    expect(screen.getAllByRole('region', { name: /^Journey stage / })).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Save journey draft' })).toBeDisabled()
    expect(api.saveJourneyDefinition).not.toHaveBeenCalled()
    expect(api.publishJourneyDefinition).not.toHaveBeenCalled()
    expect(screen.getByText(/Creating a stage does not connect your product/)).toBeInTheDocument()
  })

  it('applies a template only after explicit confirmation and does not publish it automatically', async () => {
    const api = gateway(),
      user = userEvent.setup()
    render(<JourneyDefinitionEditor {...props} gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    await user.selectOptions(screen.getByLabelText('Journey template'), 'webinar')
    expect(stage(1).getByLabelText('Stage name')).toHaveValue('Trial users')
    await user.click(screen.getByRole('button', { name: 'Apply journey template' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/custom reporting cards stay unchanged/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Replace journey draft' }))
    expect(screen.getByDisplayValue('webinar_registered')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save journey draft' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Publish journey version' })).toBeDisabled()
    expect(api.saveJourneyDefinition).not.toHaveBeenCalled()
    expect(api.publishJourneyDefinition).not.toHaveBeenCalled()
  })

  it('saves renamed stage references and only publishes the saved revision after confirmation', async () => {
    const api = gateway(),
      user = userEvent.setup(),
      onDirtyChange = vi.fn(),
      onPendingChange = vi.fn(),
      onPublished = vi.fn()
    render(
      <JourneyDefinitionEditor
        {...props}
        gateway={api}
        onDirtyChange={onDirtyChange}
        onPendingChange={onPendingChange}
        onPublished={onPublished}
      />,
    )
    await screen.findByRole('region', { name: 'Journey stage 1' })
    await user.clear(stage(1).getByLabelText('Stage key'))
    await user.type(stage(1).getByLabelText('Stage key'), 'trial_users')
    expect(screen.getByRole('button', { name: 'Publish journey version' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save journey draft' }))
    await screen.findByText(/Journey draft saved/)
    expect(api.saveJourneyDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        funnelId: 'saas-funnel',
        expectedRevision: 4,
        template: 'custom',
        definition: expect.objectContaining({
          rates: [expect.objectContaining({ steps: ['trial_users', 'activated'] })],
          paths: [expect.objectContaining({ steps: ['trial_users', 'activated', 'paid'] })],
        }),
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Publish journey version' }))
    expect(api.publishJourneyDefinition).not.toHaveBeenCalled()
    expect(screen.getByText(/including previously accepted events/)).toBeInTheDocument()
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish journey' }),
    )
    await screen.findByText(/Journey version 1 published/)
    expect(api.publishJourneyDefinition).toHaveBeenCalledWith({
      funnelId: 'saas-funnel',
      expectedRevision: 5,
    })
    expect(onPublished).toHaveBeenCalledOnce()
    expect(onDirtyChange).toHaveBeenCalledWith(true)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    expect(onPendingChange).toHaveBeenCalledWith(true)
    expect(onPendingChange).toHaveBeenLastCalledWith(false)
  })

  it('supports exact custom event keys, context/state settings and ordered path changes', async () => {
    const api = gateway(),
      user = userEvent.setup()
    render(<JourneyDefinitionEditor {...props} gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    await user.click(stage(1).getByRole('button', { name: 'Add event key' }))
    await user.type(stage(1).getByLabelText('Event key 2'), 'trial_imported')
    await user.selectOptions(stage(1).getByLabelText('Context field'), 'context_id')
    await user.type(stage(1).getByLabelText('Required state (optional)'), 'active')
    const path = within(screen.getByRole('region', { name: 'Journey path 1' }))
    await user.click(path.getByRole('button', { name: 'Move step 2 up' }))
    expect(path.getByLabelText('Step 1')).toHaveValue('activated')
    await user.click(screen.getByRole('button', { name: 'Save journey draft' }))
    await screen.findByText(/Journey draft saved/)
    expect(api.saveJourneyDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          stages: expect.arrayContaining([
            expect.objectContaining({
              eventNames: ['trial_started', 'trial_imported'],
              stateValue: 'active',
              contextField: 'context_id',
            }),
          ]),
          paths: [expect.objectContaining({ steps: ['activated', 'trial', 'paid'] })],
        }),
      }),
    )
    expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('blocks dangling stage references and custom events that try to manufacture purchases', async () => {
    const api = gateway(),
      user = userEvent.setup()
    render(<JourneyDefinitionEditor {...props} gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    await user.clear(stage(1).getByLabelText('Event key 1'))
    await user.type(stage(1).getByLabelText('Event key 1'), 'purchase_completed')
    expect(screen.getByLabelText('Journey validation issues')).toHaveTextContent(
      'Financial and identity-link events are reserved',
    )
    expect(screen.getByRole('button', { name: 'Save journey draft' })).toBeDisabled()
    await user.click(stage(1).getByRole('button', { name: 'Remove stage' }))
    expect(screen.getByLabelText('Journey validation issues')).toHaveTextContent(
      'different existing stages',
    )
    expect(screen.getAllByRole('option', { name: 'Missing stage: trial' })).toHaveLength(2)
    expect(api.saveJourneyDefinition).not.toHaveBeenCalled()
  })

  it('preserves edits on network failure and blocks conflict overwrite until deliberate reload', async () => {
    const api = gateway(),
      user = userEvent.setup()
    vi.mocked(api.saveJourneyDefinition!)
      .mockResolvedValueOnce(failure('unavailable'))
      .mockResolvedValueOnce(failure('conflict'))
    render(<JourneyDefinitionEditor {...props} gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    await user.clear(stage(1).getByLabelText('Stage name'))
    await user.type(stage(1).getByLabelText('Stage name'), 'My trial audience')
    await user.click(screen.getByRole('button', { name: 'Save journey draft' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable')
    expect(stage(1).getByLabelText('Stage name')).toHaveValue('My trial audience')
    await user.click(screen.getByRole('button', { name: 'Save journey draft' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('changed in another tab')
    expect(screen.getByRole('button', { name: 'Save journey draft' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Publish journey version' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reload journey draft' }))
    expect(api.getJourneyDefinition).toHaveBeenCalledOnce()
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Discard and reload journey',
      }),
    )
    await waitFor(() => expect(api.getJourneyDefinition).toHaveBeenCalledTimes(2))
    expect(stage(1).getByLabelText('Stage name')).toHaveValue('Trial users')
  })

  it('ignores a delayed response for the previous funnel', async () => {
    const api = gateway()
    let resolveOld!: (result: FunnelMetricsResult<JourneyDefinitionConfiguration>) => void
    vi.mocked(api.getJourneyDefinition!).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    const view = render(<JourneyDefinitionEditor {...props} gateway={api} />)
    view.rerender(<JourneyDefinitionEditor {...props} funnelId="new-funnel" gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    const old = configuration()
    old.draft.definition.stages[0].label = 'Old scope must not appear'
    await act(async () => resolveOld(ready(old)))
    expect(screen.queryByDisplayValue('Old scope must not appear')).not.toBeInTheDocument()
    expect(api.getJourneyDefinition).toHaveBeenLastCalledWith('new-funnel')
  })

  it('clears a previous funnel and ignores a delayed save after switching scope', async () => {
    const api = gateway(),
      user = userEvent.setup()
    let resolveSave!: (result: FunnelMetricsResult<JourneyDefinitionConfiguration>) => void
    vi.mocked(api.saveJourneyDefinition!).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    )
    const view = render(<JourneyDefinitionEditor {...props} gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    await user.type(stage(1).getByLabelText('Stage name'), ' old')
    await user.click(screen.getByRole('button', { name: 'Save journey draft' }))
    view.rerender(<JourneyDefinitionEditor {...props} funnelId="new-funnel" gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    const old = configuration()
    old.draft.definition.stages[0].label = 'Saved old scope'
    await act(async () => resolveSave(ready(old)))
    expect(stage(1).getByLabelText('Stage name')).toHaveValue('Trial users')
    expect(screen.queryByText(/Journey draft saved/)).not.toBeInTheDocument()
  })

  it('allows read-only inspection but disables every definition mutation', async () => {
    const api = gateway()
    render(<JourneyDefinitionEditor {...props} canManage={false} gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    expect(stage(1).getByLabelText('Stage name')).toBeDisabled()
    for (const name of [
      'Apply journey template',
      'Save journey draft',
      'Publish journey version',
      'Add journey stage',
      'Add conversion rate',
      'Add journey path',
    ])
      expect(screen.getByRole('button', { name })).toBeDisabled()
    expect(screen.getByText(/Read-only access/)).toBeInTheDocument()
    expect(api.saveJourneyDefinition).not.toHaveBeenCalled()
    expect(api.publishJourneyDefinition).not.toHaveBeenCalled()
  })
  it('copies a readable developer specification without publishing or emitting sample events', async () => {
    const api = gateway(),
      user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    render(<JourneyDefinitionEditor {...props} gateway={api} />)
    await screen.findByRole('region', { name: 'Journey stage 1' })
    await user.click(screen.getByText('Event keys for your developer'))
    await user.click(screen.getByRole('button', { name: 'Copy journey specification' }))
    await screen.findByText(/Draft specification copied/)
    const specification = JSON.parse(copy.mock.calls[0][0])
    expect(specification).toEqual(
      expect.objectContaining({
        funnel_id: 'saas-funnel',
        draft_revision: 4,
        published_version: null,
        unsaved_changes: false,
      }),
    )
    expect(specification.definition.stages[0]).toEqual({
      key: 'trial',
      label: 'Trial users',
      source: 'event',
      event_names: ['trial_started'],
    })
    expect(
      screen.getByLabelText('Draft specification JSON — configuration, not an event payload'),
    ).toHaveValue(copy.mock.calls[0][0])
    expect(api.publishJourneyDefinition).not.toHaveBeenCalled()
    expect(api.validateEvent).not.toHaveBeenCalled()
    expect(api.preview).not.toHaveBeenCalled()
    copy.mockRestore()
  })
})
