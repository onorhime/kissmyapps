import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import { commissionHeadline, formatDay } from '../../../merchant/programs'
import {
  AgreementDocument,
  AgreementSkeleton,
  BuyerOffer,
  ProgramBrowser,
  ProgramGridSkeleton,
  ProgramLogo,
  StatusPill,
} from '../../marketplace/components'
import {
  programHeadline,
  programHeadlineClass,
  programRewardLine,
  programRewardsLine,
} from '../../marketplace/model'
import type { MarketplaceProgram } from '../../marketplace/model'
import { marketplaceHash } from '../../marketplace/routing'
import type { PartnerDataGateway } from '../api'
import { earningsLine, earningsOfProgram } from '../earnings/earnings'
import type { ProgramEarnings } from '../earnings/earnings'
import { useProgramEarnings } from '../earnings/useProgramEarnings'
import { creditedFor, creditedTitle } from '../links/earnFrom'
import { PromoCodeBody } from '../links/PromoCode'
import '../earnings/ProgramEarnings.css'
import {
  brandOf,
  membershipStanding,
  programError,
  programErrorMessage,
  promoCodeShown,
  shareableLink,
} from './programs'
import type {
  PartnerMarketplace as MarketplaceData,
  PartnerProgramError,
  PartnerProgramResult,
  PartnerProgramView,
  ProgramMembership,
} from './programs'
import './PartnerMarketplace.css'

/**
 * The Marketplace page of the partner dashboard: the creator's programs and every program
 * they can join (`#marketplace`), and one program with its agreement, where they accept it
 * and get their link (`#marketplace/<slug>`).
 */

const TITLE_SUFFIX = ' · KissMyApps Partners'

export function PartnerMarketplace({
  gateway,
  slug,
}: {
  gateway: PartnerDataGateway
  slug: string | null
}) {
  return slug ? (
    <ProgramPage key={slug} gateway={gateway} slug={slug} />
  ) : (
    <MarketplaceList gateway={gateway} />
  )
}

function missing<T>(): Promise<PartnerProgramResult<T | null>> {
  return Promise.resolve({
    data: null,
    status: 'error',
    error: programError('contract_unavailable'),
  })
}

function thrown<T>(): PartnerProgramResult<T | null> {
  return { data: null, status: 'error', error: programError('temporarily_unavailable') }
}

function Working({ children }: { children: ReactNode }) {
  return (
    <>
      <LoaderCircle className="spin" size={16} aria-hidden="true" />
      {children}
    </>
  )
}

function LoadProblem({
  title,
  error,
  onRetry,
  children,
}: {
  title: string
  error: PartnerProgramError | null
  onRetry?: () => void
  children?: ReactNode
}) {
  return (
    <div className="mkt-state" role="alert">
      <h2>{title}</h2>
      <p>{programErrorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="mkt-btn mkt-btn-quiet" onClick={onRetry}>
          Try again
        </button>
      )}
      {children}
    </div>
  )
}

/**
 * The whole address, never cut short, with a Copy button. If the clipboard refuses, the
 * address is selected so it can be copied by hand.
 */
function LinkCopy({ url, label }: { url: string; label: string }) {
  const field = useRef<HTMLSpanElement>(null)
  const [copied, setCopied] = useState<'no' | 'yes' | 'manual'>('no')

  useEffect(() => {
    if (copied === 'no') return
    const timeout = setTimeout(() => setCopied('no'), 4000)
    return () => clearTimeout(timeout)
  }, [copied])

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(url)
      setCopied('yes')
    } catch {
      if (field.current) window.getSelection()?.selectAllChildren(field.current)
      setCopied('manual')
    }
  }

  return (
    <div className="pmk-link">
      <div className="pmk-link-row">
        <p className="pmk-link-url">
          <span className="mkt-sr">{label}: </span>
          <span ref={field}>
            {/* A long address wraps after a slash rather than in the middle of a word. */}
            {url.split(/(?<=[^/]\/)(?=[^/])/).map((part, index) => (
              <Fragment key={index}>
                {index > 0 && <wbr />}
                {part}
              </Fragment>
            ))}
          </span>
        </p>
        <button type="button" className="mkt-btn mkt-btn-quiet" onClick={() => void copy()}>
          {copied === 'yes' ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="pmk-link-note" role="status">
        {copied === 'manual' ? 'The link is selected. Copy it with your keyboard.' : ''}
      </p>
    </div>
  )
}

// The list ----------------------------------------------------------------------------------

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; data: MarketplaceData }
  | { status: 'error'; error: PartnerProgramError | null }

function MarketplaceList({ gateway }: { gateway: PartnerDataGateway }) {
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    document.title = `Marketplace${TITLE_SUFFIX}`
  }, [])

  useEffect(() => {
    let current = true
    const request = gateway.getMarketplace ? gateway.getMarketplace() : missing<MarketplaceData>()
    void request
      .catch(() => thrown<MarketplaceData>())
      .then((result) => {
        if (!current) return
        setState(
          result.data
            ? { status: 'ready', data: result.data }
            : { status: 'error', error: result.error },
        )
      })
    return () => {
      current = false
    }
  }, [gateway, attempt])

  const data = state.status === 'ready' ? state.data : null
  const memberships = data?.memberships ?? []
  // Earnings are an extra line on a card: the list never waits for them or fails with them.
  const earningsState = useProgramEarnings(gateway).state
  const earnings = earningsState.status === 'ready' ? earningsState.earnings : null

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            Marketplace<span className="heading-dot">.</span>
          </h1>
          <p>Apps and products you can promote. Accept a program’s agreement to get your link.</p>
        </div>
      </div>

      {state.status === 'loading' && <ProgramGridSkeleton />}

      {state.status === 'error' && (
        <LoadProblem
          title="The marketplace did not load"
          error={state.error}
          onRetry={
            state.error?.retryable === false
              ? undefined
              : () => {
                  setState({ status: 'loading' })
                  setAttempt((value) => value + 1)
                }
          }
        />
      )}

      {data && (
        <div className="pmk-page">
          {!data.tracking_ready && (
            <p className="pmk-note" role="status">
              Links are not available yet, so programs cannot be joined right now.
            </p>
          )}

          {memberships.length > 0 && (
            <section className="pmk-section" aria-labelledby="pmk-yours">
              <h2 id="pmk-yours">Your programs</h2>
              <div className="pmk-memberships">
                {memberships.map((membership) => (
                  <MembershipCard key={membership.id} membership={membership} earnings={earnings} />
                ))}
              </div>
            </section>
          )}

          <section className="pmk-section" aria-labelledby="pmk-all">
            <h2 id="pmk-all" className={memberships.length > 0 ? undefined : 'mkt-sr'}>
              All programs
            </h2>
            {data.programs.length > 0 ? (
              <ProgramBrowser
                programs={data.programs}
                hrefFor={(program) => marketplaceHash(program.slug)}
                statusFor={(program) => {
                  if (!program.membership_status) return null
                  const standing = membershipStanding(program.membership_status)
                  return <StatusPill tone={standing.tone}>{standing.label}</StatusPill>
                }}
              />
            ) : (
              <div className="mkt-state">
                <h3>No programs yet</h3>
                <p>Programs appear here as soon as a business publishes one. Check back soon.</p>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  )
}

/** What a creator needs to know about one membership, in a sentence. */
function membershipLine(membership: ProgramMembership): string | null {
  const brand = brandOf(membership.program)
  if (membership.program_status === 'archived') return 'This program has ended.'
  if (membership.status === 'pending') return `Waiting for ${brand} to approve.`
  if (membership.status === 'declined') return `${brand} declined your request.`
  if (membership.status === 'removed') return `${brand} removed you from this program.`
  if (membership.status === 'left') return 'You left this program.'
  if (membership.program_status === 'paused')
    return `Paused by ${brand}: your link still opens the page but ${creditedFor(membership.program.earn_from)} are not credited.`
  if (membership.link && !membership.link.working) return 'Your link is switched off right now.'
  return null
}

/**
 * What a program that pays for events pays, on its own page: the commission when there is one,
 * then each reward on a line. A program that pays for sales says it in its agreement, as ever.
 */
function WhatYouEarn({ program }: { program: MarketplaceProgram }) {
  if (program.earn_from === 'sales' || program.rewards.length === 0) return null
  const commission = program.earn_from === 'both' ? commissionHeadline(program) : null
  return (
    <div className="pmk-earn">
      <h3 id="pmk-earn-title">What you earn</h3>
      <ul aria-labelledby="pmk-earn-title">
        {commission && <li>{commission}</li>}
        {program.rewards.map((reward) => (
          <li key={reward.key}>{programRewardLine(reward, program.currency)}</li>
        ))}
      </ul>
    </div>
  )
}

function MembershipCard({
  membership,
  earnings,
}: {
  membership: ProgramMembership
  earnings: ProgramEarnings | null
}) {
  const { program } = membership
  const earned = earningsLine(
    earningsOfProgram(earnings, { id: membership.program_id, slug: program.slug }),
  )
  const standing = membershipStanding(
    membership.status,
    membership.program_status,
    membership.needs_new_terms,
  )
  const line = membershipLine(membership)
  const headline = programHeadline(program)
  const rewards = programRewardsLine(program)
  const href = marketplaceHash(program.slug)
  const current = membership.status === 'active' || membership.status === 'pending'
  return (
    <article className="pmk-member">
      <header className="mkt-card-head">
        <ProgramLogo name={program.name} logoPath={program.logo_path} />
        <div className="mkt-card-title">
          <h3>
            <a href={href}>{program.name}</a>
          </h3>
          {headline && (
            <p className={programHeadlineClass(program).trim() || undefined}>{headline}</p>
          )}
          {rewards && <p className="mkt-headline-rewards">{rewards}</p>}
        </div>
        <StatusPill tone={standing.tone}>{standing.label}</StatusPill>
      </header>
      {membership.status === 'active' && membership.link && (
        <LinkCopy url={shareableLink(membership.link)} label={`Your ${program.name} link`} />
      )}
      {membership.status === 'active' && membership.promo_code && (
        <PromoCodeBody promo={membership.promo_code} brand={brandOf(program)} compact />
      )}
      {earned && <p className="pe-card-line">{earned}</p>}
      {line && <p className="pmk-member-line">{line}</p>}
      {!current && membership.decision_note && (
        <p className="pmk-quote">{membership.decision_note}</p>
      )}
      {current && membership.needs_new_terms && membership.program_status !== 'archived' && (
        <p className="pmk-member-line">
          <a className="mkt-link" href={href}>
            New terms to accept
          </a>
        </p>
      )}
    </article>
  )
}

// One program -------------------------------------------------------------------------------

type ProgramState =
  | { status: 'loading' }
  | { status: 'ready'; view: PartnerProgramView }
  | { status: 'not-found' }
  | { status: 'error'; error: PartnerProgramError | null }

type Action = 'join' | 'terms' | 'leave'

function viewState(result: PartnerProgramResult<PartnerProgramView | null>): ProgramState {
  if (result.data) return { status: 'ready', view: result.data }
  if (result.error?.code === 'program_not_found') return { status: 'not-found' }
  return { status: 'error', error: result.error }
}

function fetchView(
  gateway: PartnerDataGateway,
  slug: string,
): Promise<PartnerProgramResult<PartnerProgramView | null>> {
  const request = gateway.getProgram ? gateway.getProgram(slug) : missing<PartnerProgramView>()
  return request.catch(() => thrown<PartnerProgramView>())
}

function ProgramPage({ gateway, slug }: { gateway: PartnerDataGateway; slug: string }) {
  const [state, setState] = useState<ProgramState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [mustTick, setMustTick] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const side = useRef<HTMLElement>(null)
  const checkboxId = useId()
  const view = state.status === 'ready' ? state.view : null
  const programName = view?.program.name ?? null

  useEffect(() => {
    let current = true
    void fetchView(gateway, slug).then((result) => current && setState(viewState(result)))
    return () => {
      current = false
    }
  }, [gateway, slug, attempt])

  useEffect(() => {
    document.title = `${programName ?? 'Marketplace'}${TITLE_SUFFIX}`
  }, [programName])

  /** Fetches the program again after an answer that means what is on screen is out of date. */
  async function refresh(message: string | null) {
    const result = await fetchView(gateway, slug)
    setAgreed(false)
    setMustTick(false)
    setConfirmLeave(false)
    if (result.data || result.error?.code === 'program_not_found') setState(viewState(result))
    setProblem(message)
    side.current?.focus({ preventScroll: true })
    side.current?.scrollIntoView?.({ block: 'nearest' })
  }

  async function run(
    action: Action,
    request: Promise<PartnerProgramResult<ProgramMembership | null>> | undefined,
    success: (membership: ProgramMembership) => string,
  ) {
    if (busy || !view) return
    setBusy(action)
    setProblem(null)
    setDone(null)
    let result: PartnerProgramResult<ProgramMembership | null>
    try {
      result = request ? await request : await missing<ProgramMembership>()
    } catch {
      result = thrown<ProgramMembership>()
    }
    if (result.data) {
      // Joining and leaving change the code; new terms keep it unless the answer says otherwise.
      const promoCode = result.data.promo_code ?? (action === 'terms' ? view.promo_code : null)
      setState({
        status: 'ready',
        view: { ...view, membership: result.data, promo_code: promoCode },
      })
      setAgreed(false)
      setMustTick(false)
      setConfirmLeave(false)
      setDone(success(result.data))
    } else {
      const message = programErrorMessage(result.error, 'change')
      // These mean the page no longer shows the truth: fetch it again and say why.
      const stale = [
        'terms_changed',
        'already_member',
        'membership_closed',
        'program_not_open',
        'not_a_member',
        'status_not_allowed',
        'program_not_found',
      ].includes(result.error?.code ?? '')
      if (stale) await refresh(result.error?.code === 'already_member' ? null : message)
      else setProblem(message)
    }
    setBusy(null)
  }

  if (state.status === 'loading') {
    return (
      <>
        <Crumbs name={null} />
        <div className="page-heading">
          <div>
            <h1>
              <span className="mkt-sr">Loading the program</span>
              <span className="mkt-bar" style={{ width: 240, height: 34 }} aria-hidden="true" />
            </h1>
          </div>
        </div>
        <div className="pmk-join">
          <AgreementSkeleton />
        </div>
      </>
    )
  }

  if (state.status === 'not-found') {
    return (
      <>
        <Crumbs name={null} />
        <div className="mkt-state">
          <h1>Program not found</h1>
          <p>This program does not exist or is no longer open. The link may be out of date.</p>
          <a className="mkt-btn mkt-btn-quiet" href={marketplaceHash()}>
            Back to the marketplace
          </a>
        </div>
      </>
    )
  }

  if (state.status === 'error') {
    return (
      <>
        <Crumbs name={null} />
        <LoadProblem
          title="This program did not load"
          error={state.error}
          onRetry={
            state.error?.retryable === false
              ? undefined
              : () => {
                  setState({ status: 'loading' })
                  setAttempt((value) => value + 1)
                }
          }
        />
      </>
    )
  }

  const { program, membership } = state.view
  const brand = program.agreement.brand_name || brandOf(program)
  const acceptName = state.view.accept_name
  const member = membership && membership.status !== 'left' ? membership : null
  const live = program.status === 'live'
  const programId = membership?.program_id ?? program.id
  const termsVersion = program.terms_version ?? 0
  /** What the program credits the creator for: "sales", "events", "sales and events". */
  const credited = creditedFor(program.earn_from)
  const earn = <WhatYouEarn program={program} />
  const unavailable = () =>
    Promise.resolve<PartnerProgramResult<ProgramMembership | null>>({
      data: null,
      status: 'error',
      error: programError('invalid_request', 'That is not available right now. Try again later.'),
    })

  function accept(action: 'join' | 'terms') {
    if (!agreed) {
      setMustTick(true)
      return
    }
    if (action === 'join') {
      void run(
        'join',
        gateway.joinProgram?.({
          slug: program.slug,
          termsVersion,
          agreementSha256: program.agreement_sha256,
        }),
        (joined) =>
          joined.status === 'pending'
            ? `Your request was sent to ${brand}.`
            : `You joined ${program.name}.`,
      )
    } else {
      void run(
        'terms',
        programId
          ? gateway.acceptProgramTerms?.({
              programId,
              termsVersion,
              agreementSha256: program.agreement_sha256,
            })
          : unavailable(),
        () => 'New terms accepted.',
      )
    }
  }

  const agreeBox = (
    <div className="pmk-agree">
      <label htmlFor={checkboxId}>
        <input
          id={checkboxId}
          type="checkbox"
          checked={agreed}
          aria-describedby={mustTick && !agreed ? `${checkboxId}-error` : undefined}
          aria-invalid={mustTick && !agreed ? true : undefined}
          onChange={(event) => {
            setAgreed(event.target.checked)
            if (event.target.checked) setMustTick(false)
          }}
        />
        <span>I have read and agree to this agreement</span>
      </label>
      {mustTick && !agreed && (
        <p className="pmk-error" id={`${checkboxId}-error`} role="alert">
          Tick the box to confirm you have read the agreement.
        </p>
      )}
    </div>
  )

  const acceptedLine = member?.accepted_at && (
    <p className="pmk-fine">
      Accepted{acceptName ? ` as ${acceptName}` : ''} on {formatDay(member.accepted_at)}
      {member.terms_version ? ` · Version ${member.terms_version}` : ''}
    </p>
  )

  const newTerms = member &&
    (member.status === 'active' || member.status === 'pending') &&
    member.needs_new_terms &&
    program.status !== 'archived' && (
      <div className="pmk-block">
        <h3>New terms to accept</h3>
        <p>
          {brand} published version {termsVersion}. It is the agreement on this page. Until you
          accept it, the version you accepted before still applies.
        </p>
        {agreeBox}
        <button
          type="button"
          className="mkt-btn mkt-btn-primary mkt-btn-wide"
          disabled={busy !== null}
          onClick={() => accept('terms')}
        >
          {busy === 'terms' ? <Working>Accepting</Working> : 'Accept new terms'}
        </button>
      </div>
    )

  const leaveLabel = member?.status === 'pending' ? 'Cancel request' : 'Leave program'
  const leave = member && (member.status === 'active' || member.status === 'pending') && (
    <div className="pmk-leave">
      {confirmLeave ? (
        <div className="pmk-block" role="group" aria-label={leaveLabel}>
          <p>
            {member.status === 'pending'
              ? `Cancel your request to join ${program.name}?`
              : `Leave ${program.name}? ${creditedTitle(program.earn_from)} from your link will no longer be credited to you.`}
          </p>
          <div className="pmk-actions">
            <button
              type="button"
              className="mkt-btn mkt-btn-quiet"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  'leave',
                  programId ? gateway.leaveProgram?.(programId) : unavailable(),
                  () =>
                    member.status === 'pending'
                      ? 'Your request was cancelled.'
                      : `You left ${program.name}.`,
                )
              }
            >
              {busy === 'leave' ? (
                <Working>{member.status === 'pending' ? 'Cancelling' : 'Leaving'}</Working>
              ) : (
                leaveLabel
              )}
            </button>
            <button
              type="button"
              className="mkt-link"
              disabled={busy !== null}
              onClick={() => setConfirmLeave(false)}
            >
              {member.status === 'pending' ? 'Keep waiting' : 'Stay in the program'}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="mkt-link mkt-link-quiet"
          onClick={() => {
            setConfirmLeave(true)
            setProblem(null)
          }}
        >
          {leaveLabel}
        </button>
      )}
    </div>
  )

  let box: ReactNode
  if (program.status === 'archived') {
    box = (
      <>
        <h2>This program has ended</h2>
        <p>
          {member?.status === 'active'
            ? `${brand} closed it. Your link no longer works.`
            : 'It can no longer be joined.'}
        </p>
        {acceptedLine}
      </>
    )
  } else if (member?.status === 'active') {
    const link = member.link
    const promo = promoCodeShown(program, state.view.promo_code)
    const standing = membershipStanding(
      'active',
      program.status === 'paused' ? 'paused' : member.program_status,
    )
    box = (
      <>
        <div className="pmk-side-head">
          <h2>Your link</h2>
          <StatusPill tone={standing.tone}>{standing.label}</StatusPill>
        </div>
        {link ? (
          <LinkCopy url={shareableLink(link)} label={`Your ${program.name} link`} />
        ) : (
          <p>Your link is not ready yet. Reload this page in a moment.</p>
        )}
        <p>
          {member.program_status === 'paused' || program.status === 'paused'
            ? `Paused by ${brand}: your link still opens the page but ${credited} are not credited.`
            : link && !link.working
              ? `Your link is switched off right now, so ${credited} are not credited.`
              : link
                ? `${creditedTitle(program.earn_from)} that come through this link are credited to you.`
                : null}
        </p>
        <BuyerOffer program={program} discount={false} />
        {promo && (
          <div className="pmk-block p8-promo-side">
            <h3>Promo code</h3>
            <PromoCodeBody
              promo={promo}
              brand={brand}
              appliedByLink={program.payment_mode === 'kma_checkout'}
            />
          </div>
        )}
        {earn}
        {newTerms}
        {acceptedLine}
        {leave}
      </>
    )
  } else if (member?.status === 'pending') {
    box = (
      <>
        <div className="pmk-side-head">
          <h2>Waiting for approval</h2>
          <StatusPill tone="waiting">Waiting</StatusPill>
        </div>
        <p>
          {brand} approves each creator. Your link appears here as soon as they approve you. There
          is nothing else to do.
        </p>
        {earn}
        <BuyerOffer program={program} />
        {newTerms}
        {acceptedLine}
        {leave}
      </>
    )
  } else if (member) {
    box = (
      <>
        <h2>{member.status === 'declined' ? 'Request declined' : 'Removed from this program'}</h2>
        <p>
          {member.status === 'declined'
            ? `${brand} declined your request to join.`
            : `${brand} removed you from this program. Your link no longer credits ${credited}.`}
        </p>
        {member.decision_note && <p className="pmk-quote">{member.decision_note}</p>}
      </>
    )
  } else if (!live) {
    box = (
      <>
        <h2>Not taking new creators</h2>
        <p>{brand} has paused this program. Check back later.</p>
      </>
    )
  } else {
    const manual = program.approval_mode === 'manual'
    box = (
      <>
        <h2>{manual ? 'Accept and ask to join' : 'Accept and get your link'}</h2>
        <p>
          {manual
            ? `No signature. ${brand} approves each creator, and your link is created as soon as they approve you.`
            : 'No signature or waiting. Your link is created as soon as you accept.'}
        </p>
        {earn}
        <BuyerOffer program={program} />
        {acceptName ? (
          <>
            {agreeBox}
            <p>
              Accepting as <strong>{acceptName}</strong>
            </p>
            <button
              type="button"
              className="mkt-btn mkt-btn-primary mkt-btn-wide"
              disabled={busy !== null}
              onClick={() => accept('join')}
            >
              {busy === 'join' ? (
                <Working>Accepting</Working>
              ) : manual ? (
                'Accept and ask to join'
              ) : (
                'Accept and get my link'
              )}
            </button>
            <p className="pmk-fine">We record the version you accepted and the date.</p>
          </>
        ) : (
          <div className="pmk-block">
            <p>
              <strong>Add your name first.</strong> The agreement is accepted under the name in your
              profile, and yours is empty.
            </p>
            <a className="mkt-btn mkt-btn-quiet" href="#profile">
              Open your profile
            </a>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <Crumbs name={program.name} />
      <div className="page-heading">
        <div>
          <h1>{member ? program.name : `Join ${program.name}`}</h1>
        </div>
      </div>
      <div className={`pmk-join ${member ? 'pmk-join-member' : ''}`}>
        <AgreementDocument
          doc={program.agreement}
          logoPath={program.logo_path}
          subline={`Between ${brand} and ${acceptName ?? 'you'} · Version ${termsVersion}`}
          headingId="pmk-agreement-title"
        />
        <aside className="mkt-side pmk-side" ref={side} tabIndex={-1} aria-label="Your membership">
          {done && (
            <p className="pmk-done" role="status">
              <Check size={16} aria-hidden="true" />
              {done}
            </p>
          )}
          {membership?.status === 'left' && !done && live && (
            <p>You left this program. Accept the agreement to join it again.</p>
          )}
          {box}
          {problem && (
            <p className="pmk-error" role="alert">
              {problem}
            </p>
          )}
        </aside>
      </div>
    </>
  )
}

function Crumbs({ name }: { name: string | null }) {
  return (
    <nav className="mkt-crumbs" aria-label="Breadcrumb">
      <a href={marketplaceHash()}>Marketplace</a>
      {name && (
        <>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{name}</span>
        </>
      )}
    </nav>
  )
}
