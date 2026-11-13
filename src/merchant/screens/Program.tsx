import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Check, ChevronDown, Circle, ImageIcon, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import {
  agreementReady,
  appPlatforms,
  asksEarnFrom,
  blankReward,
  categoryLabels,
  changedInput,
  changesAgreement,
  checkLogoFile,
  commissionExample,
  currencies,
  describeProblem,
  draftEarning,
  draftFromProgram,
  draftProgress,
  draftTerms,
  earnFromAbout,
  earnHeadline,
  earningStep,
  formatDay,
  formatMoney,
  initials,
  isAppLink,
  landingKindOf,
  linkAddress,
  offersAppLanding,
  optionFields,
  optionsSummary,
  ProgramError,
  programs,
  rewardField,
  trackingLine,
  trackingSnippet,
  trackingSnippetNote,
  validateDraft,
  withRewardEvent,
} from '../programs'
import type {
  AgreementDoc,
  AppLink,
  Category,
  Checklist,
  DraftErrors,
  DraftField,
  EarnFrom,
  LandingKind,
  Program,
  ProgramAppLink,
  ProgramDraft,
  ProgramProblem,
  ProgramState,
  ProgramStatus,
  ProgramStep,
  RewardPart,
  RewardRow,
  Tracking,
} from '../programs'
import { personHue } from '../format'
import { href } from '../routes'
import { useStore } from '../store'
import { CodeBlock, Field, PageHeader, Pill, Segmented, Skeleton } from '../ui/Primitives'
import type { PillTone } from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'
import { RewardFields } from './ProgramRewards'
import type { RewardEvents } from './ProgramRewards'

const REVIEW_REFRESH_MS = 60_000
const TRACKING_REFRESH_MS = 60_000
const CONNECTIONS = href({ name: 'connections' })
const BALANCE = href({ name: 'balance' })

/** What the page is busy with; one thing at a time. */
type Busy = 'idle' | 'saving' | 'publishing' | 'pausing' | 'resuming' | 'uploading' | 'opening'

/** Something the person asked for that can be asked for again. */
type Action = 'save' | 'publish' | 'agreement' | 'pause' | 'resume'

type Notice =
  { tone: 'problem'; problem: ProgramProblem; again?: Action } | { tone: 'news'; message: string }

/** The agreement reader: closed, fetching, showing the document, or saying why it cannot. */
type Reader =
  | { open: false }
  | { open: true; loading: true }
  | { open: true; loading: false; doc: AgreementDoc; sha256: string; note?: string }
  | { open: true; loading: false; problem: string }

const statusPills: Record<ProgramStatus | 'none', { tone: PillTone; label: string }> = {
  none: { tone: 'neutral', label: 'Not published' },
  draft: { tone: 'neutral', label: 'Not published' },
  in_review: { tone: 'info', label: 'In review' },
  changes_requested: { tone: 'warning', label: 'Changes requested' },
  live: { tone: 'positive', label: 'Live' },
  paused: { tone: 'warning', label: 'Paused' },
  archived: { tone: 'neutral', label: 'Archived' },
}

const sameDraft = (a: ProgramDraft, b: ProgramDraft) => JSON.stringify(a) === JSON.stringify(b)

/** Failures the page can tell by itself, before asking the server. */
const incomplete = new ProgramError('program_incomplete')
const unread = new ProgramError('agreement_not_read')

export function ProgramScreen() {
  const { workspace } = useStore()
  return workspace ? (
    <ProgramPage workspaceId={workspace.id} workspaceName={workspace.name} />
  ) : null
}

function ProgramPage({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string
  workspaceName: string
}) {
  const { signOut, notify, now, projects } = useStore()
  const [state, setState] = useState<ProgramState>()
  const [loadProblem, setLoadProblem] = useState<ProgramProblem>()
  const [draft, setDraft] = useState<ProgramDraft>(() => draftFromProgram(null))
  const [errors, setErrors] = useState<DraftErrors>({})
  const [busy, setBusy] = useState<Busy>('idle')
  const [notice, setNotice] = useState<Notice>()
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [reader, setReader] = useState<Reader>({ open: false })
  const [errorFocus, setErrorFocus] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  // Each answer is numbered, so a slow one never overwrites what a newer one showed.
  const latest = useRef(0)
  // Whether the person set creator approval themselves since the form was last filled.
  const approvalChosen = useRef(false)
  // Where creator links send people, and the address each choice last held, so switching
  // between a web page and the app loses nothing.
  const [landingKind, setLandingKind] = useState<LandingKind>('web')
  const landingKept = useRef<Record<LandingKind, string>>({ web: '', app: '' })

  /** The landing page as the program has it saved. */
  const keepLanding = useCallback((saved: Program | null) => {
    const kind = landingKindOf(saved)
    setLandingKind(kind)
    landingKept.current = { web: '', app: '', [kind]: saved?.landing_url ?? '' }
  }, [])

  /** Everything on the page follows the server's latest answer, the form included. */
  const adopt = useCallback(
    (next: ProgramState) => {
      latest.current += 1
      setState(next)
      setDraft(draftFromProgram(next.program, asksEarnFrom(next)))
      keepLanding(next.program)
      setErrors({})
      approvalChosen.current = false
      setLoadProblem(undefined)
    },
    [keepLanding],
  )

  const load = useCallback(
    async (quiet = false) => {
      const run = ++latest.current
      let next: ProgramState
      try {
        next = await programs.get(workspaceId)
      } catch (problem) {
        // A background refresh that fails keeps what is on screen.
        if (run !== latest.current || quiet) return
        setLoadProblem(describeProblem(problem, 'load'))
        return
      }
      if (run === latest.current) adopt(next)
    },
    [workspaceId, adopt],
  )

  useEffect(() => {
    void load()
  }, [load])

  const program = state?.program ?? null
  const status = program?.status
  // Asked when the workspace can pay for events; otherwise the form is the one for sales.
  const asks = asksEarnFrom(state)
  const earnFrom = draft.earnFrom ?? 'sales'
  const saved = useMemo(() => draftFromProgram(program, asks), [program, asks])
  const dirty = Boolean(state) && !sameDraft(draft, saved)
  const editable = Boolean(state?.can_manage) && status !== 'in_review'
  // Asked when the workspace has smart links of an app; otherwise the landing page is a web page.
  const offersApp = offersAppLanding(state)
  const appLanding = offersApp && landingKind === 'app'

  // A review ends without the person doing anything, so the page looks for the answer itself.
  useEffect(() => {
    if (status !== 'in_review') return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(true)
    }, REVIEW_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [status, load])

  // Back online: read the program again without being asked.
  useEffect(() => {
    if (!loadProblem) return
    const retry = () => void load()
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [loadProblem, load])

  // Closing the tab with edits in the form asks first.
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // A refused save puts the cursor in the first field that needs fixing.
  useEffect(() => {
    if (errorFocus)
      root.current
        ?.querySelector<HTMLElement>(
          '[aria-invalid="true"], [data-invalid="true"] [aria-pressed="true"]',
        )
        ?.focus({ preventScroll: false })
  }, [errorFocus])

  const tracking = useRpc(`program-tracking:${workspaceId}`, () => programs.tracking(workspaceId), {
    pollMs: TRACKING_REFRESH_MS,
  })

  // The events a reward can be tied to are only read once the program pays for events.
  const received = useRpc(
    `program-events:${workspaceId}`,
    () => programs.rewardEvents(workspaceId),
    { enabled: asks && earnFrom !== 'sales' },
  )
  const events: RewardEvents = received.data
    ? { status: 'ready', events: received.data }
    : received.error
      ? { status: 'failed' }
      : { status: 'loading' }

  // The smart links a program can send people to, read once the form offers an app.
  const appLinks = useRpc(
    `program-app-links:${workspaceId}`,
    () => programs.appLinks(workspaceId),
    { enabled: offersApp },
  )
  const linkChoices: AppLinks = appLinks.data
    ? { status: 'ready', links: appLinks.data }
    : appLinks.error
      ? { status: 'failed' }
      : { status: 'loading' }
  const savedLink = program?.app_link ?? null
  // The saved link as the list has it, found by its id.
  const savedUrl =
    savedLink && (appLinks.data?.find((link) => isAppLink(savedLink, link))?.url ?? savedLink.url)
  // The saved link stands for the saved address, which may carry more than the link itself.
  const chosenUrl =
    savedUrl && draft.landingUrl === program?.landing_url ? savedUrl : draft.landingUrl
  const chosenLink = appLinks.data?.find((link) => link.url === chosenUrl)
  // Attribution is set up per app: the chosen link's, else the first that has links.
  const appProject = chosenLink?.project_id || appLinks.data?.[0]?.project_id || projects[0]?.id

  // The buttons in a notice run the newest version of each action.
  const actions = useRef<Record<Action, () => void>>({
    save: () => {},
    publish: () => {},
    agreement: () => {},
    pause: () => {},
    resume: () => {},
  })

  const set = <K extends keyof ProgramDraft>(
    key: K,
    value: ProgramDraft[K],
    field?: DraftField,
  ) => {
    if (key === 'approvalMode') approvalChosen.current = true
    setDraft((current) => ({ ...current, [key]: value }))
    if (field && errors[field]) setErrors(({ [field]: _fixed, ...rest }) => rest)
  }

  const chooseEarnFrom = (value: EarnFrom) => {
    // An event has no payment behind it, so the business approves each creator of a program
    // that pays for events, unless it already decided how creators are approved.
    const decided = approvalChosen.current || (program?.earn_from ?? 'sales') !== 'sales'
    setDraft((current) => ({
      ...current,
      earnFrom: value,
      approvalMode: decided
        ? current.approvalMode
        : value === 'sales'
          ? saved.approvalMode
          : 'manual',
    }))
    if (errors.earnFrom) setErrors(({ earnFrom: _fixed, ...rest }) => rest)
  }

  /** Puts back the rewards with one row changed, added or removed. */
  const setRewards = (change: (rows: RewardRow[]) => RewardRow[]) =>
    setDraft((current) => {
      const rows = change(current.rewards ?? [])
      return { ...current, rewards: rows.length ? rows : [blankReward()] }
    })

  const chooseLanding = (kind: LandingKind) => {
    if (kind === landingKind) return
    landingKept.current[landingKind] = draft.landingUrl
    setLandingKind(kind)
    set('landingUrl', landingKept.current[kind], 'landingUrl')
  }

  const chooseLink = (url: string) =>
    set(
      'landingUrl',
      savedUrl && program?.landing_url && url === savedUrl ? program.landing_url : url,
      'landingUrl',
    )

  const changeReward = (index: number, patch: Partial<RewardRow>) => {
    setRewards((rows) =>
      rows.map((row, at) =>
        at !== index
          ? row
          : patch.key === undefined
            ? { ...row, ...patch }
            : { ...withRewardEvent(row, patch.key, received.data), ...patch },
      ),
    )
    // The fields that were edited are no longer known to be wrong, nor is the list as a whole.
    const fixed = new Set<string>(['rewards'])
    for (const part of Object.keys(patch) as RewardPart[]) fixed.add(rewardField(index, part))
    if (patch.key !== undefined) fixed.add(rewardField(index, 'label'))
    if (Object.keys(errors).some((field) => fixed.has(field)))
      setErrors((current) =>
        Object.fromEntries(Object.entries(current).filter(([field]) => !fixed.has(field))),
      )
  }

  const removeReward = (index: number) => {
    setRewards((rows) => rows.filter((_, at) => at !== index))
    // The rows below move up, so what was said about each row no longer points at it.
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([field]) => !/^rewards?(:|$)/.test(field)),
      ),
    )
  }

  const showErrors = (found: DraftErrors) => {
    setErrors(found)
    if (optionFields.some((field) => found[field])) setOptionsOpen(true)
    setErrorFocus((count) => count + 1)
  }

  /** Says what went wrong where it belongs: at the field, or above the form. */
  const fail = async (problem: unknown, step: ProgramStep, again?: Action) => {
    const described = describeProblem(problem, step, earnFrom)
    if (described.field) {
      showErrors({ ...errors, [described.field]: described.message })
      return
    }
    // The page no longer matched the server, so it reads the program again and says so.
    if (described.recovery === 'reload') {
      await load(true)
      setNotice({ tone: 'news', message: described.message })
      return
    }
    // The server knows better than the page whether this person may change the program.
    if (described.code === 'not_allowed')
      setState((current) => current && { ...current, can_manage: false })
    setNotice({
      tone: 'problem',
      problem: described,
      again: described.recovery === 'retry' ? again : undefined,
    })
  }

  /** Saves the form. Returns the server's answer, or null when nothing was saved. */
  const persist = async (): Promise<ProgramState | null> => {
    const found = validateDraft(draft, status === 'live' || status === 'paused')
    if (Object.keys(found).length) {
      showErrors(found)
      return null
    }
    try {
      const next = await programs.save(workspaceId, changedInput(draft, program))
      adopt(next)
      return next
    } catch (problem) {
      await fail(problem, 'save', 'save')
      return null
    }
  }

  const save = async () => {
    if (busy !== 'idle' || !dirty) return
    setNotice(undefined)
    setBusy('saving')
    const next = await persist()
    setBusy('idle')
    const draftStill =
      next?.program?.status === 'draft' || next?.program?.status === 'changes_requested'
    if (next) notify(draftStill ? 'Draft saved' : 'Changes saved')
  }

  const loadAgreement = async (note?: string) => {
    setReader({ open: true, loading: true })
    try {
      const answer = await programs.agreement(workspaceId)
      if (!answer.complete || !answer.agreement || !answer.sha256) {
        setReader({ open: false })
        setNotice({
          tone: 'problem',
          problem: describeProblem(incomplete, 'agreement', earnFrom),
        })
        return
      }
      setReader({
        open: true,
        loading: false,
        doc: answer.agreement,
        sha256: answer.sha256,
        note,
      })
    } catch (problem) {
      setReader({
        open: true,
        loading: false,
        problem: describeProblem(problem, 'agreement').message,
      })
    }
  }

  const openAgreement = async () => {
    if (busy !== 'idle') return
    setNotice(undefined)
    // The agreement is written from what is saved, so the form is saved first.
    if (editable && dirty) {
      setBusy('opening')
      const next = await persist()
      setBusy('idle')
      if (!next) return
    }
    await loadAgreement()
  }

  const confirmRead = async (sha256: string) => {
    setBusy('opening')
    try {
      adopt(await programs.markAgreementRead(workspaceId, sha256))
      setReader({ open: false })
      notify('Agreement read')
    } catch (problem) {
      const described = describeProblem(problem, 'read')
      if (described.code === 'agreement_not_read') {
        // The terms changed while the reader was open: show what creators will now agree to.
        await load(true)
        await loadAgreement('The terms changed while this was open. This is the latest agreement.')
      } else {
        setReader({ open: true, loading: false, problem: described.message })
      }
    } finally {
      setBusy('idle')
    }
  }

  const publish = async () => {
    if (busy !== 'idle') return
    setNotice(undefined)
    setBusy('publishing')
    try {
      let current = state
      if (dirty) {
        const next = await persist()
        if (!next) return
        current = next
      }
      if (!current?.program) return
      if (!current.can_submit) {
        setNotice({
          tone: 'problem',
          problem: describeProblem(
            current.checklist.agreement_read ? incomplete : unread,
            'publish',
            earnFrom,
          ),
        })
        return
      }
      const wasLive = current.program.status === 'live' || current.program.status === 'paused'
      try {
        adopt(await programs.submit(workspaceId, current.program.revision))
        notify(wasLive ? 'Changes published' : 'Sent for review')
      } catch (problem) {
        await fail(problem, 'publish', 'publish')
      }
    } finally {
      setBusy('idle')
    }
  }

  const setStatus = async (next: 'paused' | 'live') => {
    if (busy !== 'idle' || !program) return
    setNotice(undefined)
    setBusy(next === 'paused' ? 'pausing' : 'resuming')
    try {
      adopt(await programs.setStatus(workspaceId, next, program.revision))
      notify(next === 'paused' ? 'Program paused' : 'Program is live again')
    } catch (problem) {
      await fail(problem, 'status', next === 'paused' ? 'pause' : 'resume')
    } finally {
      setBusy('idle')
    }
  }

  const uploadLogo = async (file: File) => {
    const refusal = checkLogoFile(file)
    if (refusal) {
      setErrors((current) => ({ ...current, logo: refusal }))
      return
    }
    setErrors(({ logo: _fixed, ...rest }) => rest)
    setBusy('uploading')
    try {
      set('logoPath', await programs.uploadLogo(workspaceId, file))
    } catch (problem) {
      const described = describeProblem(problem, 'logo')
      setErrors((current) => ({ ...current, logo: described.message }))
    } finally {
      setBusy('idle')
    }
  }

  useEffect(() => {
    actions.current = {
      save: () => void save(),
      publish: () => void publish(),
      agreement: () => void openAgreement(),
      pause: () => void setStatus('paused'),
      resume: () => void setStatus('live'),
    }
  })

  const pill = statusPills[status ?? 'none']
  const paused = status === 'paused' ? program?.pause_reason : null
  const idle = busy === 'idle'

  let headerAction: ReactNode = null
  if (state?.can_manage && status === 'live')
    headerAction = (
      <button
        type="button"
        className="mc-btn mc-btn-quiet"
        disabled={!idle}
        onClick={() => void setStatus('paused')}
      >
        {busy === 'pausing' ? <Working>Pausing</Working> : 'Pause'}
      </button>
    )
  // A program paused for its balance goes live again by itself when funds arrive.
  else if (
    state?.can_manage &&
    paused &&
    paused !== 'admin' &&
    paused !== 'balance_empty' &&
    state.stripe_connected
  )
    headerAction = (
      <button
        type="button"
        className="mc-btn mc-btn-quiet"
        disabled={!idle}
        onClick={() => void setStatus('live')}
      >
        {busy === 'resuming' ? <Working>Resuming</Working> : 'Resume'}
      </button>
    )

  // While the form has edits it answers for itself; once saved, the server's word stands.
  const checklist: Checklist | undefined = state && {
    ...state.checklist,
    ...(editable && dirty
      ? {
          ...draftProgress(draft),
          agreement_read: state.checklist.agreement_read && !changesAgreement(draft, program),
        }
      : {}),
  }
  const complete = Boolean(checklist?.details && checklist.landing_page && checklist.commission)
  // The agreement needs less than publishing does: a name, a landing page and a commission.
  const readable = agreementReady(draft)

  const saleTracking = state && (
    <section className="mc-panel mc-prog-track" aria-labelledby="mc-prog-track">
      <div className="mc-prog-label">
        <h2 id="mc-prog-track">Sale tracking</h2>
        <p>How a sale is tied to a creator</p>
      </div>
      <div className="mc-prog-fields">
        <p className="mc-prog-about">
          Creator links add a click ID to your landing page. Pass it to Stripe when a customer pays,
          and the sale is credited to that creator.
        </p>
        <CodeBlock code={trackingSnippet} label="Pass the click ID to Stripe" />
        <p className="mc-prog-about">{trackingSnippetNote}</p>
        <TrackingStatus
          connected={state.stripe_connected}
          tracking={tracking.data}
          failed={Boolean(tracking.error) && !tracking.data}
          onRetry={() => void tracking.refresh()}
          now={now}
        />
      </div>
    </section>
  )

  return (
    <div className="mc-page mc-prog" ref={root}>
      <PageHeader
        title="Affiliate program"
        description="Tell creators what they are promoting and what they earn. You can change any of this after you publish."
        actions={
          state && (
            <>
              <Pill tone={pill.tone}>{pill.label}</Pill>
              {headerAction}
            </>
          )
        }
      />

      {!state && !loadProblem && <Loading />}

      {loadProblem && !state && (
        <section className="mc-panel" aria-label="Program">
          <Problem
            problem={loadProblem}
            onRetry={() => {
              setLoadProblem(undefined)
              void load()
            }}
            onSignIn={() => void signOut()}
          />
        </section>
      )}

      {state && checklist && (
        <>
          <Banner state={state} workspaceName={workspaceName} />

          {notice?.tone === 'problem' && (
            <Problem
              problem={notice.problem}
              onRetry={notice.again ? () => actions.current[notice.again!]() : undefined}
              onSignIn={() => void signOut()}
            />
          )}
          {notice?.tone === 'news' && (
            <p className="mc-prog-note" role="status">
              {notice.message}
            </p>
          )}

          {!state.can_manage && !program ? (
            <section className="mc-panel" aria-label="Program">
              <p className="mc-prog-none">
                {workspaceName} has no affiliate program yet. An owner or admin can set one up here.
              </p>
            </section>
          ) : (
            <div className="mc-prog-layout">
              <div className="mc-prog-main">
                <ProgramForm
                  draft={draft}
                  errors={errors}
                  set={set}
                  editable={editable}
                  dirty={dirty}
                  busy={busy}
                  hasProgram={Boolean(program)}
                  workspaceId={workspaceId}
                  optionsOpen={optionsOpen}
                  onToggleOptions={() => setOptionsOpen((open) => !open)}
                  onUpload={(file) => void uploadLogo(file)}
                  onSave={() => void save()}
                  onDiscard={() => {
                    setDraft(saved)
                    keepLanding(program)
                    setErrors({})
                    approvalChosen.current = false
                  }}
                  landingKind={offersApp ? landingKind : undefined}
                  onLandingKind={chooseLanding}
                  appPicker={
                    <AppLinkPicker
                      links={linkChoices}
                      value={chosenUrl}
                      saved={savedLink}
                      error={errors.landingUrl && 'Choose the smart link creators send people to.'}
                      linksHref={
                        projects[0] &&
                        href({ name: 'attribution', projectId: projects[0].id, section: 'links' })
                      }
                      onChoose={chooseLink}
                      onRetry={() => void appLinks.refresh()}
                    />
                  }
                  asks={asks}
                  onEarnFrom={chooseEarnFrom}
                  rewards={
                    <RewardFields
                      rows={draft.rewards ?? []}
                      budget={draft.budget ?? ''}
                      currency={draft.currency}
                      errors={errors}
                      events={events}
                      editable={editable}
                      installHref={
                        projects[0] &&
                        href({ name: 'settings', projectId: projects[0].id, section: 'install' })
                      }
                      app={appLanding}
                      onRow={changeReward}
                      onAdd={() => setRewards((rows) => [...rows, blankReward()])}
                      onRemove={removeReward}
                      onBudget={(value) => set('budget', value, 'budget')}
                      onRetryEvents={() => void received.refresh()}
                    />
                  }
                />

                {earnFrom !== 'sales' && appLanding ? (
                  <>
                    {earnFrom === 'both' && saleTracking}
                    <AppTracking
                      setupHref={
                        appProject &&
                        href({ name: 'attribution', projectId: appProject, section: 'setup' })
                      }
                    />
                  </>
                ) : earnFrom === 'events' ? (
                  <section className="mc-panel mc-prog-track" aria-labelledby="mc-prog-track">
                    <div className="mc-prog-label">
                      <h2 id="mc-prog-track">Event tracking</h2>
                      <p>How an event is tied to a creator</p>
                    </div>
                    <div className="mc-prog-fields">
                      <p className="mc-prog-about">
                        Creator links add a click ID to your landing page. The KissMyApps tracking
                        code on your site ties what that person does next to the creator, so there
                        is nothing more to add.
                      </p>
                    </div>
                  </section>
                ) : (
                  saleTracking
                )}
              </div>

              <aside className="mc-prog-side" aria-label="Preview and publishing">
                <Preview draft={draft} workspaceId={workspaceId} />
                <Publishing
                  state={state}
                  checklist={checklist}
                  earnFrom={earnFrom}
                  complete={complete}
                  readable={readable}
                  editable={editable}
                  termsEdited={editable && dirty && changesAgreement(draft, program)}
                  busy={busy}
                  onRead={() => void openAgreement()}
                  onPublish={() => void publish()}
                />
              </aside>
            </div>
          )}
        </>
      )}

      <AgreementReader
        reader={reader}
        logo={<LogoMark path={draft.logoPath} name={draft.name} workspaceId={workspaceId} />}
        mustConfirm={editable && Boolean(program) && !program?.agreement_read}
        confirming={busy === 'opening'}
        onClose={() => busy === 'idle' && setReader({ open: false })}
        onRetry={() => void loadAgreement()}
        onConfirm={(sha256) => void confirmRead(sha256)}
      />
    </div>
  )
}

function Working({ children }: { children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="mc-spin" size={16} aria-hidden="true" /> {children}
    </>
  )
}

/** A failure above the form, with the one thing that gets past it. */
function Problem({
  problem,
  onRetry,
  onSignIn,
}: {
  problem: ProgramProblem
  onRetry?: () => void
  onSignIn: () => void
}) {
  return (
    <p className="mc-error-note mc-prog-problem" role="alert">
      <TriangleAlert size={16} aria-hidden="true" />
      <span>{problem.message}</span>
      {problem.recovery === 'retry' && onRetry && (
        <button type="button" className="mc-text-btn" onClick={onRetry}>
          Retry
        </button>
      )}
      {problem.recovery === 'sign-in' && (
        <button type="button" className="mc-text-btn" onClick={onSignIn}>
          Sign in again
        </button>
      )}
      {problem.recovery === 'connections' && (
        <a className="mc-text-btn" href={CONNECTIONS}>
          Connect Stripe
        </a>
      )}
      {problem.recovery === 'balance' && (
        <a className="mc-text-btn" href={BALANCE}>
          Add funds
        </a>
      )}
    </p>
  )
}

/** Where the program stands when that needs saying: in review, sent back, paused, or read-only. */
function Banner({ state, workspaceName }: { state: ProgramState; workspaceName: string }) {
  const program = state.program
  let body: ReactNode = null
  let tone: 'info' | 'warning' = 'info'
  if (program?.status === 'in_review') {
    body = <p>We are reviewing your listing. This usually takes a day.</p>
  } else if (program?.status === 'changes_requested') {
    tone = 'warning'
    body = (
      <>
        <p>
          <strong>KissMyApps asked for changes before this can go live.</strong>
        </p>
        {program.review_note && <p className="mc-prog-review-note">{program.review_note}</p>}
      </>
    )
  } else if (program?.status === 'paused') {
    tone = 'warning'
    if (program.pause_reason === 'admin')
      body = (
        <>
          <p>
            <strong>KissMyApps paused this program.</strong> Contact us to find out what is needed.
          </p>
          {program.review_note && <p className="mc-prog-review-note">{program.review_note}</p>}
        </>
      )
    else if (program.pause_reason === 'stripe_disconnected')
      body = (
        <p>
          This program is paused because Stripe was disconnected.{' '}
          {state.stripe_connected ? (
            'Stripe is connected again, so you can resume it.'
          ) : (
            <a className="mc-link" href={CONNECTIONS}>
              Connect Stripe
            </a>
          )}
        </p>
      )
    else if (program.pause_reason === 'balance_empty')
      body = (
        <p>
          This program is paused because its balance could not cover a commission. It goes live
          again when you add funds.{' '}
          <a className="mc-link" href={BALANCE}>
            {state.can_manage ? 'Add funds' : 'Open Balance'}
          </a>
        </p>
      )
    else body = <p>You paused this program. Resume it when you are ready.</p>
  }
  const readOnly = !state.can_manage && program
  if (!body && !readOnly) return null
  return (
    <div className={`mc-prog-banner is-${tone}`} role="status">
      {body}
      {readOnly && <p>Only an owner or admin of {workspaceName} can change the program.</p>}
    </div>
  )
}

function Loading() {
  return (
    <div className="mc-prog-layout" role="status" aria-label="Loading your program">
      <div className="mc-prog-main">
        <div className="mc-panel mc-prog-form">
          {['Product', 'Landing page', 'Commission', 'More options'].map((label, index) => (
            <div className="mc-prog-section" key={label}>
              <div className="mc-prog-label">
                <h2>{label}</h2>
              </div>
              <div className="mc-prog-fields">
                <Skeleton width="100%" height={40} />
                {index === 0 && <Skeleton width="100%" height={40} />}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mc-prog-side">
        <div className="mc-panel">
          <Skeleton width="50%" />
          <Skeleton width="100%" height={120} />
        </div>
        <div className="mc-panel">
          <Skeleton width="45%" height={18} />
          <Skeleton width="70%" />
          <Skeleton width="60%" />
          <Skeleton width="65%" />
          <Skeleton width="100%" height={44} />
        </div>
      </div>
    </div>
  )
}

/** The logo, or the product's initials until one is uploaded or if it will not load. */
function LogoMark({
  path,
  name,
  workspaceId,
  size = 56,
}: {
  path: string | null
  name: string
  workspaceId: string
  size?: number
}) {
  const [failed, setFailed] = useState<string | null>(null)
  if (path && failed !== path)
    return (
      <img
        className="mc-prog-logo"
        src={programs.logoUrl(path)}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(path)}
      />
    )
  const letters = initials(name)
  // Nothing to stand for the product yet: an empty frame, not a mark.
  if (!letters)
    return (
      <span
        className="mc-prog-logo is-empty"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <ImageIcon size={Math.round(size * 0.36)} />
      </span>
    )
  const hue = ['blue', 'amber', 'pink', 'green', 'violet', 'teal'][personHue(workspaceId)]
  return (
    <span
      className={`mc-project-mark mc-prog-logo is-${hue}`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {letters}
    </span>
  )
}

/** A field whose label is said but not shown, because the control beside it already names it. */
function Bare({
  label,
  error,
  className = '',
  children,
}: {
  label: string
  error?: string
  className?: string
  children: (props: {
    id: string
    'aria-describedby'?: string
    'aria-invalid'?: boolean
  }) => ReactNode
}) {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <div className={`${error ? 'mc-field has-error' : 'mc-field'} ${className}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      {children({
        id,
        'aria-describedby': error ? errorId : undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {error && (
        <p id={errorId} className="mc-field-error">
          {error}
        </p>
      )}
    </div>
  )
}

function ProgramForm({
  draft,
  errors,
  set,
  editable,
  dirty,
  busy,
  hasProgram,
  workspaceId,
  optionsOpen,
  onToggleOptions,
  onUpload,
  onSave,
  onDiscard,
  landingKind,
  onLandingKind,
  appPicker,
  asks,
  onEarnFrom,
  rewards,
}: {
  draft: ProgramDraft
  errors: DraftErrors
  set: <K extends keyof ProgramDraft>(key: K, value: ProgramDraft[K], field?: DraftField) => void
  editable: boolean
  dirty: boolean
  busy: Busy
  hasProgram: boolean
  workspaceId: string
  optionsOpen: boolean
  onToggleOptions: () => void
  onUpload: (file: File) => void
  onSave: () => void
  onDiscard: () => void
  /** Where creator links send people, when the form asks. Without it, to a web page. */
  landingKind?: LandingKind
  onLandingKind: (kind: LandingKind) => void
  /** The smart link to send people to, shown when they go to the app. */
  appPicker: ReactNode
  /** Whether the form asks what creators earn from. Without it, the program pays for sales. */
  asks: boolean
  onEarnFrom: (value: EarnFrom) => void
  /** The reward rows and their budget, shown when the program pays for events. */
  rewards: ReactNode
}) {
  const file = useRef<HTMLInputElement>(null)
  const change = useRef<HTMLButtonElement>(null)
  const options = useRef<HTMLDivElement>(null)
  const toggled = useRef(false)
  const optionsId = useId()
  const logoErrorId = useId()
  const earnFrom = draft.earnFrom ?? 'sales'
  const terms = draftTerms(draft)
  const example = commissionExample(terms)
  const dollars = draft.currency === 'USD'
  const idle = busy === 'idle'
  const wrong = Object.keys(errors).length > 0
  // A currency saved outside the short list stays selectable.
  const currencyChoices = (currencies as readonly string[]).includes(draft.currency)
    ? currencies
    : [...currencies, draft.currency]

  const toggleOptions = () => {
    toggled.current = true
    onToggleOptions()
  }
  // The button that was pressed is gone after the press, so focus moves to what replaced it.
  useEffect(() => {
    if (!toggled.current) return
    toggled.current = false
    if (optionsOpen) options.current?.querySelector<HTMLElement>('input, select')?.focus()
    else change.current?.focus()
  }, [optionsOpen])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave()
  }

  return (
    <form
      className="mc-panel mc-prog-form"
      aria-label="Program details"
      noValidate
      onSubmit={submit}
    >
      <fieldset className="mc-prog-set" disabled={!editable}>
        <section className="mc-prog-section" aria-labelledby="mc-prog-product">
          <div className="mc-prog-label">
            <h2 id="mc-prog-product">Product</h2>
            <p>Shown on your marketplace card</p>
          </div>
          <div className="mc-prog-fields">
            <div className="mc-prog-pair">
              <Field label="Name" error={errors.name}>
                {(props) => (
                  <input
                    {...props}
                    value={draft.name}
                    maxLength={120}
                    autoComplete="off"
                    onChange={(event) => set('name', event.target.value, 'name')}
                  />
                )}
              </Field>
              <Field label="Category" error={errors.category}>
                {(props) => (
                  <span className="mc-select-box">
                    <select
                      {...props}
                      value={draft.category}
                      onChange={(event) =>
                        set('category', event.target.value as Category | '', 'category')
                      }
                    >
                      <option value="">Choose one</option>
                      {(Object.keys(categoryLabels) as Category[]).map((key) => (
                        <option key={key} value={key}>
                          {categoryLabels[key]}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={16} aria-hidden="true" />
                  </span>
                )}
              </Field>
            </div>
            <Field label="One-line description" error={errors.tagline}>
              {(props) => (
                <input
                  {...props}
                  value={draft.tagline}
                  maxLength={160}
                  autoComplete="off"
                  onChange={(event) => set('tagline', event.target.value, 'tagline')}
                />
              )}
            </Field>
            <div className={errors.logo ? 'mc-field has-error' : 'mc-field'}>
              <span className="mc-prog-caption">Logo</span>
              <div className="mc-prog-logo-row">
                <LogoMark path={draft.logoPath} name={draft.name} workspaceId={workspaceId} />
                <button
                  type="button"
                  className="mc-btn mc-btn-quiet"
                  disabled={!idle}
                  aria-describedby={errors.logo ? logoErrorId : undefined}
                  onClick={() => file.current?.click()}
                >
                  {busy === 'uploading' ? (
                    <Working>Uploading</Working>
                  ) : draft.logoPath ? (
                    'Replace logo'
                  ) : (
                    'Upload logo'
                  )}
                </button>
                <span className="mc-field-hint">PNG, JPG or WebP, up to 2 MB</span>
                <input
                  ref={file}
                  type="file"
                  hidden
                  aria-label="Logo file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0]
                    // Choosing the same file again must still count as a choice.
                    event.target.value = ''
                    if (chosen) onUpload(chosen)
                  }}
                />
              </div>
              {errors.logo && (
                <p id={logoErrorId} className="mc-field-error" role="alert">
                  {errors.logo}
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="mc-prog-section" aria-labelledby="mc-prog-landing">
          <div className="mc-prog-label">
            <h2 id="mc-prog-landing">Landing page</h2>
            <p>Where creator links send people</p>
          </div>
          <div className="mc-prog-fields">
            {landingKind && (
              <div className="mc-pga-kind">
                <Segmented
                  label="Where creator links send people"
                  value={landingKind}
                  options={[
                    { value: 'web', label: 'A web page' },
                    { value: 'app', label: 'Your app' },
                  ]}
                  onChange={onLandingKind}
                />
              </div>
            )}
            {landingKind === 'app' ? (
              appPicker
            ) : (
              <Bare label="Landing page address" error={errors.landingUrl}>
                {(props) => (
                  <input
                    {...props}
                    type="url"
                    inputMode="url"
                    value={draft.landingUrl}
                    placeholder="https://"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    maxLength={2000}
                    onChange={(event) => set('landingUrl', event.target.value, 'landingUrl')}
                  />
                )}
              </Bare>
            )}
          </div>
        </section>

        {asks && (
          <section className="mc-prog-section" aria-labelledby="mc-prog-earn">
            <div className="mc-prog-label">
              <h2 id="mc-prog-earn">Earnings</h2>
              <p>What do creators earn from?</p>
            </div>
            <div className="mc-prog-fields">
              <div
                className={
                  errors.earnFrom ? 'mc-field mc-pgr-earn has-error' : 'mc-field mc-pgr-earn'
                }
                data-invalid={errors.earnFrom ? true : undefined}
              >
                <Segmented
                  label="What do creators earn from?"
                  value={earnFrom}
                  options={[
                    { value: 'sales', label: 'Sales' },
                    { value: 'events', label: 'Events' },
                    { value: 'both', label: 'Both' },
                  ]}
                  onChange={onEarnFrom}
                />
                {errors.earnFrom && (
                  <p className="mc-field-error" role="alert">
                    {errors.earnFrom}
                  </p>
                )}
              </div>
              <p className="mc-prog-example">{earnFromAbout[earnFrom]}</p>
            </div>
          </section>
        )}

        {earnFrom !== 'events' && (
          <section className="mc-prog-section" aria-labelledby="mc-prog-commission">
            <div className="mc-prog-label">
              <h2 id="mc-prog-commission">Commission</h2>
              <p>What a creator earns per sale</p>
            </div>
            <div className="mc-prog-fields">
              <div className="mc-prog-line">
                <Segmented
                  label="Commission type"
                  value={draft.commissionType}
                  options={[
                    { value: 'percent', label: 'Percent' },
                    { value: 'fixed', label: 'Fixed amount' },
                  ]}
                  onChange={(value) => set('commissionType', value, 'amount')}
                />
                <Bare
                  label={
                    draft.commissionType === 'percent' ? 'Commission percent' : 'Commission amount'
                  }
                  error={errors.amount}
                  className="mc-prog-amount"
                >
                  {(props) =>
                    draft.commissionType === 'percent' ? (
                      <div className="mc-affix">
                        <input
                          {...props}
                          inputMode="decimal"
                          value={draft.percent}
                          placeholder="30"
                          autoComplete="off"
                          onChange={(event) => set('percent', event.target.value, 'amount')}
                        />
                        <span aria-hidden="true">%</span>
                      </div>
                    ) : (
                      <div className={dollars ? 'mc-affix is-prefix' : 'mc-affix'}>
                        {dollars && <span aria-hidden="true">$</span>}
                        <input
                          {...props}
                          inputMode="decimal"
                          value={draft.fixed}
                          placeholder="20.00"
                          autoComplete="off"
                          onChange={(event) => set('fixed', event.target.value, 'amount')}
                        />
                        {!dollars && <span aria-hidden="true">{draft.currency}</span>}
                      </div>
                    )
                  }
                </Bare>
              </div>
              <div className="mc-prog-line">
                <Segmented
                  label="Commission lasts"
                  value={draft.duration}
                  options={[
                    { value: 'first_payment', label: 'First payment' },
                    {
                      value: 'months',
                      label: /^\d{1,2}$/.test(draft.months.trim())
                        ? `${Number(draft.months)} ${Number(draft.months) === 1 ? 'month' : 'months'}`
                        : 'Months',
                    },
                    { value: 'lifetime', label: 'Every payment' },
                  ]}
                  onChange={(value) => set('duration', value, 'months')}
                />
              </div>
              {example && <p className="mc-prog-example">{example}</p>}
            </div>
          </section>
        )}

        {earnFrom !== 'sales' && (
          <section className="mc-prog-section" aria-labelledby="mc-prog-rewards">
            <div className="mc-prog-label">
              <h2 id="mc-prog-rewards">Rewards</h2>
              <p>What a creator earns per event, once per person</p>
            </div>
            <div className="mc-prog-fields">{rewards}</div>
          </section>
        )}

        <section className="mc-prog-section" aria-labelledby="mc-prog-options">
          <div className="mc-prog-label">
            <h2 id="mc-prog-options">More options</h2>
            <p>Sensible defaults, change if needed</p>
          </div>
          <div className="mc-prog-fields">
            {!optionsOpen && (
              <div className="mc-prog-summary">
                <ul>
                  {optionsSummary(draft).map((part) => (
                    <li key={part}>{part}</li>
                  ))}
                </ul>
                <button
                  ref={change}
                  type="button"
                  className="mc-btn mc-btn-quiet"
                  aria-expanded={false}
                  onClick={toggleOptions}
                >
                  Change
                </button>
              </div>
            )}
            {optionsOpen && (
              <div id={optionsId} ref={options} className="mc-prog-options">
                <Field label="Attribution window" error={errors.attributionDays}>
                  {(props) => (
                    <div className="mc-affix">
                      <input
                        {...props}
                        inputMode="numeric"
                        value={draft.attributionDays}
                        autoComplete="off"
                        onChange={(event) =>
                          set('attributionDays', event.target.value, 'attributionDays')
                        }
                      />
                      <span aria-hidden="true">days</span>
                    </div>
                  )}
                </Field>
                <Field label="Hold before payout" error={errors.holdDays}>
                  {(props) => (
                    <div className="mc-affix">
                      <input
                        {...props}
                        inputMode="numeric"
                        value={draft.holdDays}
                        autoComplete="off"
                        onChange={(event) => set('holdDays', event.target.value, 'holdDays')}
                      />
                      <span aria-hidden="true">days</span>
                    </div>
                  )}
                </Field>
                <Field label="Minimum payout" error={errors.minimumPayout}>
                  {(props) => (
                    <div className={dollars ? 'mc-affix is-prefix' : 'mc-affix'}>
                      {dollars && <span aria-hidden="true">$</span>}
                      <input
                        {...props}
                        inputMode="decimal"
                        value={draft.minimumPayout}
                        autoComplete="off"
                        onChange={(event) =>
                          set('minimumPayout', event.target.value, 'minimumPayout')
                        }
                      />
                      {!dollars && <span aria-hidden="true">{draft.currency}</span>}
                    </div>
                  )}
                </Field>
                <Field label="Currency" error={errors.currency}>
                  {(props) => (
                    <span className="mc-select-box">
                      <select
                        {...props}
                        value={draft.currency}
                        onChange={(event) => set('currency', event.target.value, 'currency')}
                      >
                        {currencyChoices.map((code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={16} aria-hidden="true" />
                    </span>
                  )}
                </Field>
                {draft.duration === 'months' && earnFrom !== 'events' && (
                  <Field label="Months of commission" error={errors.months}>
                    {(props) => (
                      <div className="mc-affix">
                        <input
                          {...props}
                          inputMode="numeric"
                          value={draft.months}
                          autoComplete="off"
                          onChange={(event) => set('months', event.target.value, 'months')}
                        />
                        <span aria-hidden="true">months</span>
                      </div>
                    )}
                  </Field>
                )}
                <div className="mc-field mc-prog-wide">
                  <span className="mc-prog-caption">Creator approval</span>
                  <Segmented
                    label="Creator approval"
                    value={draft.approvalMode}
                    options={[
                      { value: 'automatic', label: 'Automatic' },
                      { value: 'manual', label: 'I approve each creator' },
                    ]}
                    onChange={(value) => set('approvalMode', value)}
                  />
                </div>
                <label className="mc-prog-toggle mc-prog-wide">
                  <span>Listed in the marketplace</span>
                  <span className="mc-switch">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={draft.marketplaceListed}
                      onChange={(event) => set('marketplaceListed', event.target.checked)}
                    />
                    <span aria-hidden="true" className="mc-switch-track" />
                  </span>
                </label>
                <div className="mc-prog-wide">
                  <Field
                    label="Extra terms (optional)"
                    hint="Added to the end of your agreement"
                    error={errors.extraTerms}
                  >
                    {(props) => (
                      <textarea
                        {...props}
                        rows={4}
                        value={draft.extraTerms}
                        maxLength={4000}
                        onChange={(event) => set('extraTerms', event.target.value, 'extraTerms')}
                      />
                    )}
                  </Field>
                </div>
                <button
                  type="button"
                  className="mc-text-btn mc-prog-hide"
                  aria-expanded
                  aria-controls={optionsId}
                  onClick={toggleOptions}
                >
                  Hide options
                </button>
              </div>
            )}
          </div>
        </section>
      </fieldset>

      {editable && (
        <div className={dirty ? 'mc-prog-save is-dirty' : 'mc-prog-save'}>
          <p role="status" className={wrong ? 'is-wrong' : undefined}>
            {wrong
              ? 'Fix the marked fields, then save.'
              : dirty
                ? 'Unsaved changes'
                : hasProgram
                  ? 'All changes saved'
                  : 'Nothing saved yet'}
          </p>
          {dirty && hasProgram && (
            <button type="button" className="mc-text-btn" disabled={!idle} onClick={onDiscard}>
              Discard
            </button>
          )}
          <button type="submit" className="mc-btn mc-btn-secondary" disabled={!dirty || !idle}>
            {busy === 'saving' ? <Working>Saving</Working> : 'Save'}
          </button>
        </div>
      )}
    </form>
  )
}

/** The smart links a program can send people to: still loading, the list, or that it failed. */
type AppLinks = { status: 'loading' } | { status: 'ready'; links: AppLink[] } | { status: 'failed' }

/**
 * The smart link creator links send people to, when they go to the app: one of the workspace's
 * links, grouped by app, with the address it opens and the platforms the app is on.
 */
function AppLinkPicker({
  links,
  value,
  saved,
  error,
  linksHref,
  onChoose,
  onRetry,
}: {
  links: AppLinks
  /** The address the landing page is now. */
  value: string
  /** The link the program has saved, kept selectable when it is no longer listed. */
  saved: ProgramAppLink | null
  error?: string
  /** Where smart links are made, when the workspace has a project to make them in. */
  linksHref?: string
  onChoose: (url: string) => void
  onRetry: () => void
}) {
  const listed = links.status === 'ready' ? links.links : []
  const unlisted = saved && !listed.some((link) => isAppLink(saved, link)) ? saved : null
  const known = listed.find((link) => link.url === value)
  const chosen = known ?? (unlisted?.url === value ? unlisted : undefined)
  // Links of one app sit under its name, which says the platforms it is on.
  const apps: Array<{ key: string; label: string; links: AppLink[] }> = []
  for (const link of listed) {
    const label = [link.project_name || 'Your app', appPlatforms(link)].filter(Boolean).join(' · ')
    const key = `${link.project_id}:${label}`
    const last = apps[apps.length - 1]
    if (last?.key === key) last.links.push(link)
    else apps.push({ key, label, links: [link] })
  }

  return (
    <>
      {links.status === 'failed' && (
        <p className="mc-error-note mc-prog-problem" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>Your smart links could not be loaded.</span>
          <button type="button" className="mc-text-btn" onClick={onRetry}>
            Retry
          </button>
        </p>
      )}
      {links.status === 'loading' && !unlisted ? (
        <span className="mc-pga-wait" role="status" aria-label="Loading your smart links">
          <Skeleton width="100%" height={40} />
        </span>
      ) : listed.length === 0 && !unlisted ? (
        links.status === 'ready' && (
          <p className="mc-prog-about">
            Your apps have no active smart links yet. Make one in Attribution, then choose it here.
            {linksHref && (
              <>
                {' '}
                <a className="mc-link mc-pga-go" href={linksHref}>
                  Make a smart link
                </a>
              </>
            )}
          </p>
        )
      ) : (
        <div className="mc-pga-link">
          <Field label="Smart link" error={error}>
            {(props) => (
              <span className="mc-select-box">
                <select
                  {...props}
                  value={chosen ? chosen.url : ''}
                  onChange={(event) => onChoose(event.target.value)}
                >
                  <option value="" disabled={Boolean(chosen)}>
                    Choose a link
                  </option>
                  {unlisted && (
                    <option value={unlisted.url}>
                      {unlisted.name} · {linkAddress(unlisted.url)}
                    </option>
                  )}
                  {apps.map((app) => (
                    <optgroup key={app.key} label={app.label}>
                      {app.links.map((link) => (
                        <option key={link.id} value={link.url}>
                          {link.name} · {linkAddress(link.url)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <ChevronDown size={16} aria-hidden="true" />
              </span>
            )}
          </Field>
          {/* Only a listed link says which app it is for and the platforms that app is on. */}
          {known && (
            <p className="mc-pga-chosen">
              {appPlatforms(known) ? (
                <>
                  <span>For {known.project_name || 'your app'} on</span>
                  <span className="mc-pga-marks">
                    {known.ios && <Pill tone="neutral">iOS</Pill>}
                    {known.android && <Pill tone="neutral">Android</Pill>}
                  </span>
                </>
              ) : (
                <span>
                  {known.project_name || 'This app'} has no iPhone or Android app in its attribution
                  setup yet, so the link cannot open it.
                </span>
              )}
            </p>
          )}
        </div>
      )}
    </>
  )
}

/** How an install is tied to a creator, for a program that sends people to an app. */
function AppTracking({ setupHref }: { setupHref?: string }) {
  return (
    <section className="mc-panel mc-prog-track" aria-labelledby="mc-pga-track">
      <div className="mc-prog-label">
        <h2 id="mc-pga-track">Event tracking</h2>
        <p>How an install is tied to a creator</p>
      </div>
      <div className="mc-prog-fields">
        <p className="mc-prog-about">
          Creator links open your smart link with a click ID. The KissMyApps SDK{'\u00a0'}1.1 or
          later in your app matches each install to that click, so the install and what the person
          does next in the app are credited to the creator.
        </p>
        <p className="mc-prog-about">
          Your smart links must open the app: add Associated Domains on iPhone and App Links on
          Android.
          {setupHref && (
            <>
              {' '}
              <a className="mc-link mc-pga-go" href={setupHref}>
                Set up attribution
              </a>
            </>
          )}
        </p>
      </div>
    </section>
  )
}

function TrackingStatus({
  connected,
  tracking,
  failed,
  onRetry,
  now,
}: {
  connected: boolean
  tracking: Tracking | undefined
  failed: boolean
  onRetry: () => void
  now: number
}) {
  if (!connected)
    return (
      <p className="mc-prog-status" role="status">
        <span className="mc-status-dot" aria-hidden="true" />
        <span>
          <a className="mc-link" href={CONNECTIONS}>
            Connect Stripe
          </a>{' '}
          to start tracking sales.
        </span>
      </p>
    )
  if (failed)
    return (
      <p className="mc-prog-status" role="status">
        <span className="mc-status-dot" aria-hidden="true" />
        <span>The tracking status could not be loaded.</span>
        <button type="button" className="mc-text-btn" onClick={onRetry}>
          Retry
        </button>
      </p>
    )
  if (!tracking)
    return (
      <p className="mc-prog-status" role="status" aria-label="Loading the tracking status">
        <Skeleton width={220} />
      </p>
    )
  const line = trackingLine({ ...tracking, connected: true }, now)
  return (
    <p className="mc-prog-status" role="status">
      <span
        className={
          line.tone === 'on'
            ? 'mc-status-dot is-on'
            : line.tone === 'warning'
              ? 'mc-status-dot is-warning'
              : 'mc-status-dot'
        }
        aria-hidden="true"
      />
      <span className="mc-num">{line.text}</span>
    </p>
  )
}

/** The marketplace card as a creator will read it, redrawn as the form changes. */
function Preview({ draft, workspaceId }: { draft: ProgramDraft; workspaceId: string }) {
  const earning = draftEarning(draft)
  const headline = earnHeadline(earning)
  // For events the line already names every reward; beside a commission they are listed.
  const listed = earning.earn_from === 'both' ? earning.rewards : []
  const window = /^\d{1,3}$/.test(draft.attributionDays.trim())
    ? Number(draft.attributionDays)
    : null
  return (
    <section className="mc-panel mc-prog-preview" aria-labelledby="mc-prog-preview">
      <h2 id="mc-prog-preview">How creators will see it</h2>
      <div className="mc-prog-card">
        <div className="mc-prog-card-head">
          <LogoMark path={draft.logoPath} name={draft.name} workspaceId={workspaceId} size={44} />
          <div>
            <strong className={draft.name.trim() ? undefined : 'is-blank'}>
              {draft.name.trim() || 'Your product'}
            </strong>
            <span>{draft.category ? categoryLabels[draft.category] : 'Category'}</span>
          </div>
        </div>
        <p className={draft.tagline.trim() ? 'mc-prog-card-text' : 'mc-prog-card-text is-blank'}>
          {draft.tagline.trim() || 'Your one-line description'}
        </p>
        <p className={headline ? 'mc-prog-card-earn mc-num' : 'mc-prog-card-earn is-blank'}>
          {headline ?? earningStep[earning.earn_from].blank}
        </p>
        {listed.length > 0 && (
          <ul className="mc-pgr-card-list" aria-label="Rewards">
            {listed.map((reward) => (
              <li key={reward.key}>
                <span>{reward.label}</span>
                <span className="mc-num">{formatMoney(reward.amount_minor, earning.currency)}</span>
              </li>
            ))}
          </ul>
        )}
        {window !== null && <p className="mc-prog-card-meta mc-num">{window}-day attribution</p>}
      </div>
    </section>
  )
}

/** The checklist, with the step for what creators earn in the words of what the program pays for. */
const stepsFor = (
  earnFrom: EarnFrom,
): Array<{ key: keyof Checklist; done: string; todo: string }> => [
  { key: 'stripe_connected', done: 'Stripe connected', todo: 'Connect Stripe' },
  { key: 'details', done: 'Product details', todo: 'Product details' },
  { key: 'landing_page', done: 'Landing page', todo: 'Landing page' },
  { key: 'commission', ...earningStep[earnFrom] },
  { key: 'agreement_read', done: 'Agreement read', todo: 'Read your agreement' },
]

/** The last step: what is still missing, the agreement, and the button that publishes. */
function Publishing({
  state,
  checklist,
  earnFrom,
  complete,
  readable,
  editable,
  termsEdited,
  busy,
  onRead,
  onPublish,
}: {
  state: ProgramState
  checklist: Checklist
  earnFrom: EarnFrom
  /** Everything a listing needs is filled in. */
  complete: boolean
  /** Enough is filled in for the agreement to be written. */
  readable: boolean
  editable: boolean
  /** The form holds unsaved changes to what creators agree to. */
  termsEdited: boolean
  busy: Busy
  onRead: () => void
  onPublish: () => void
}) {
  const program: Program | null = state.program
  const status = program?.status
  const idle = busy === 'idle'
  const published = status === 'live' || status === 'paused'
  const changes = published && (program?.has_unpublished_changes || termsEdited)
  const ready = Object.values(checklist).every(Boolean)
  // After a save the server decides; before it, the form's own answers stand in.
  const canPublish = editable && ready && !termsEdited && state.can_submit

  const read = (
    <button
      type="button"
      className="mc-btn mc-btn-quiet mc-btn-wide"
      disabled={!readable || !idle}
      onClick={onRead}
    >
      {busy === 'opening' ? <Working>Opening</Working> : 'Read agreement'}
    </button>
  )
  const publish = (label: string) => (
    <button
      type="button"
      className="mc-btn mc-btn-primary mc-btn-wide"
      disabled={!canPublish || !idle}
      onClick={onPublish}
    >
      {busy === 'publishing' ? <Working>Publishing</Working> : label}
    </button>
  )

  if (status === 'in_review')
    return (
      <section className="mc-panel mc-prog-ready" aria-labelledby="mc-prog-ready">
        <h2 id="mc-prog-ready">In review</h2>
        {program?.submitted_at && (
          <p className="mc-prog-ready-text">Sent on {formatDay(program.submitted_at)}.</p>
        )}
        {read}
      </section>
    )

  if (published && !changes)
    return (
      <section className="mc-panel mc-prog-ready" aria-labelledby="mc-prog-ready">
        <h2 id="mc-prog-ready">Published</h2>
        {program?.first_published_at && (
          <p className="mc-prog-ready-text">
            {status === 'live' ? 'Live since' : 'First published'}{' '}
            {formatDay(program.first_published_at)}.
          </p>
        )}
        {read}
        {editable && (
          <p className="mc-prog-hint">
            Edits to the product card apply when you save. Changes to the terms apply when you
            publish them.
          </p>
        )}
      </section>
    )

  if (published)
    return (
      <section className="mc-panel mc-prog-ready" aria-labelledby="mc-prog-ready">
        <h2 id="mc-prog-ready">Changes to publish</h2>
        <p className="mc-prog-ready-text">
          Creators keep the terms you last published until you publish these changes.
        </p>
        {read}
        {editable && publish('Publish changes')}
        {editable && !canPublish && (
          <p className="mc-prog-hint">
            {!state.stripe_connected
              ? 'Connect Stripe to publish.'
              : 'Publish unlocks once you have read the updated agreement.'}
          </p>
        )}
      </section>
    )

  let hint: string
  if (!readable) hint = 'Fill in the sections on this page to see your agreement.'
  else if (!complete) hint = 'Add a category and a one-line description to publish.'
  else if (!checklist.agreement_read) hint = 'Publish unlocks once you have read the agreement.'
  else if (!checklist.stripe_connected) hint = 'Connect Stripe to publish.'
  else hint = 'KissMyApps reviews your first listing once, usually within a day.'

  return (
    <section className="mc-panel mc-prog-ready" aria-labelledby="mc-prog-ready">
      <h2 id="mc-prog-ready">Ready to publish</h2>
      <ul className="mc-prog-steps">
        {stepsFor(earnFrom).map((step) => {
          const done = checklist[step.key]
          return (
            <li key={step.key} className={done ? 'is-done' : undefined}>
              {done ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Circle size={14} aria-hidden="true" />
              )}
              <span className="sr-only">{done ? 'Done: ' : 'To do: '}</span>
              {step.key === 'stripe_connected' && !done ? (
                <a className="mc-link" href={CONNECTIONS}>
                  {step.todo}
                </a>
              ) : (
                <span>{done ? step.done : step.todo}</span>
              )}
            </li>
          )
        })}
      </ul>
      {read}
      {editable && publish('Publish program')}
      {editable && <p className="mc-prog-hint">{hint}</p>}
    </section>
  )
}

/** The generated agreement, read top to bottom before it can be marked as read. */
function AgreementReader({
  reader,
  logo,
  mustConfirm,
  confirming,
  onClose,
  onRetry,
  onConfirm,
}: {
  reader: Reader
  logo: ReactNode
  mustConfirm: boolean
  confirming: boolean
  onClose: () => void
  onRetry: () => void
  onConfirm: (sha256: string) => void
}) {
  const body = useRef<HTMLDivElement>(null)
  // Which document has been scrolled to its end; a new one starts unread.
  const [finished, setFinished] = useState<string | null>(null)
  const doc = reader.open && !reader.loading && 'doc' in reader ? reader : null
  const sha256 = doc?.sha256
  const reachedEnd = Boolean(sha256) && finished === sha256

  const measure = useCallback(() => {
    const element = body.current
    if (element && sha256 && element.scrollHeight - element.scrollTop - element.clientHeight <= 32)
      setFinished(sha256)
  }, [sha256])

  // The observer reports once as it starts, so a document short enough to fit is at its end already.
  useEffect(() => {
    const element = body.current
    if (!sha256 || !element) return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [sha256, measure])

  return (
    <DialogPrimitive.Root open={reader.open} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="mc-dialog-overlay" />
        <DialogPrimitive.Content
          className="mc-prog-doc mc-app-tokens"
          aria-describedby={undefined}
          aria-busy={reader.open && reader.loading}
        >
          <div className="mc-prog-doc-head">
            <DialogPrimitive.Title>{doc ? doc.doc.title : 'Your agreement'}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="mc-icon-btn" aria-label="Close">
              <X size={18} aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          {reader.open && reader.loading && (
            <div className="mc-prog-doc-body" role="status" aria-label="Loading the agreement">
              <Skeleton width="40%" height={18} />
              <Skeleton width="100%" />
              <Skeleton width="92%" />
              <Skeleton width="96%" />
              <Skeleton width="60%" />
            </div>
          )}

          {reader.open && !reader.loading && 'problem' in reader && (
            <div className="mc-prog-doc-body">
              <p className="mc-error-note" role="alert">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>{reader.problem}</span>
                <button type="button" className="mc-text-btn" onClick={onRetry}>
                  Retry
                </button>
              </p>
            </div>
          )}

          {doc && (
            <>
              <div className="mc-prog-doc-body" ref={body} tabIndex={0} onScroll={measure}>
                {doc.note && (
                  <p className="mc-prog-note" role="status">
                    {doc.note}
                  </p>
                )}
                <div className="mc-prog-doc-brand">
                  {logo}
                  <div>
                    <strong>{doc.doc.program_name}</strong>
                    {doc.doc.brand_name && doc.doc.brand_name !== doc.doc.program_name && (
                      <span>{doc.doc.brand_name}</span>
                    )}
                  </div>
                </div>
                {doc.doc.summary.length > 0 && (
                  <dl className="mc-prog-doc-summary">
                    {doc.doc.summary.map((row) => (
                      <div key={row.label}>
                        <dt>{row.label}</dt>
                        <dd className="mc-num">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {doc.doc.sections.map((section) => (
                  <section key={section.heading}>
                    <h3>{section.heading}</h3>
                    {section.paragraphs.map((paragraph, index) => (
                      <p key={index}>{paragraph}</p>
                    ))}
                  </section>
                ))}
                {/* The last section already introduces these, so they follow it with no heading. */}
                {doc.doc.extra_terms && <p className="mc-prog-doc-extra">{doc.doc.extra_terms}</p>}
              </div>
              <div className="mc-prog-doc-foot">
                {mustConfirm ? (
                  <>
                    <p role="status">
                      {reachedEnd
                        ? 'That is the whole agreement.'
                        : 'Scroll to the end to continue.'}
                    </p>
                    <button
                      type="button"
                      className="mc-btn mc-btn-primary"
                      disabled={!reachedEnd || confirming}
                      onClick={() => onConfirm(doc.sha256)}
                    >
                      {confirming ? <Working>Saving</Working> : 'I have read this'}
                    </button>
                  </>
                ) : (
                  <DialogPrimitive.Close className="mc-btn mc-btn-secondary">
                    Close
                  </DialogPrimitive.Close>
                )}
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
