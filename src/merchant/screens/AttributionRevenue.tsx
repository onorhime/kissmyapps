import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import type { Attribution, Project, RevenueEvent, RevenueSetup, Role, StoreProvider } from '../api'
import { CURRENCIES } from '../attribution'
import { formatAgo, formatCount, plural } from '../format'
import { href } from '../routes'
import {
  ECB_CURRENCIES,
  MAX_REVENUE_EVENTS,
  checkRevenueEvents,
  formatMoney,
  plainDate,
  revenueSnippets,
  skipReason,
  unconvertedNote,
} from '../roi'
import type { RevenueEventErrors } from '../roi'
import { canDo, useStore } from '../store'
import { CodeBlock, ErrorNote, Field, Segmented, Select, Skeleton } from '../ui/Primitives'
import type { RpcState } from '../ui/useRpc'
import { useRpc } from '../ui/useRpc'
import { SettingsRow } from './Settings'

// Revenue: the Settings card that says how payments reach the project and which events are
// payments, and the Setup step with each SDK's revenue call.

const STORE_NAMES: Record<StoreProvider, string> = { revenuecat: 'RevenueCat', adapty: 'Adapty' }

function useAction() {
  const { notify } = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : 'That did not work.'
      setError(message)
      notify(message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

// Settings > Revenue ----------------------------------------------------------------------------

export function RevenueSettings({
  project,
  view,
  role,
}: {
  project: Project
  view: Attribution
  role?: Role
}) {
  const state = useRpc(`attribution-revenue:${project.id}`, () => api.revenueSetup(project.id))
  const setup = state.data
  return (
    <SettingsRow
      title="Revenue"
      description={
        <>
          <p>The payments ROI and Cohorts count, and how they reach {project.name}.</p>
          <p>
            Payments sent with the SDK&rsquo;s revenue call count on their own. List an event here
            only when your app or site already sends each payment as an event.
          </p>
        </>
      }
    >
      {state.error && !setup ? (
        <ErrorNote message={state.error} onRetry={() => void state.refresh()} />
      ) : !setup ? (
        <div className="mc-form-stack" aria-busy="true">
          <Skeleton width="100%" height={180} />
          <Skeleton width="100%" height={140} />
        </div>
      ) : (
        <div className="mc-form-stack">
          <RevenueStatus project={project} setup={setup} />
          <PaymentEvents
            key={JSON.stringify(setup.events)}
            project={project}
            view={view}
            role={role}
            setup={setup}
            onSaved={state.refresh}
          />
        </div>
      )}
    </SettingsRow>
  )
}

function RevenueStatus({ project, setup }: { project: Project; setup: RevenueSetup }) {
  const { now } = useStore()
  const id = useId()
  const last = setup.last_7d
  const fromEvents = setup.by_origin.find((item) => item.origin === 'event')?.payments ?? 0
  const fromStores = setup.by_origin.find((item) => item.origin === 'store')?.payments ?? 0
  // Both tools are always listed; connected says whether this project has one set up.
  const connected = setup.stores.filter((store) => store.connected)
  const noRate = !ECB_CURRENCIES.has(setup.currency)
  const connections = (
    <a className="mc-link" href={href({ name: 'connections' })}>
      Connections
    </a>
  )

  return (
    <section className="mc-panel mc-at3-revenue" aria-labelledby={id}>
      <div className="mc-panel-head">
        <div>
          <h2 id={id}>Last 7 days</h2>
          <p>
            {setup.last_received_at
              ? `Last payment ${formatAgo(setup.last_received_at, Math.max(now, Date.parse(setup.last_received_at)))}.`
              : `No payments from ${project.name} yet.`}
          </p>
        </div>
      </div>
      <dl className="mc-facts mc-facts-row">
        <div>
          <dt>Revenue</dt>
          <dd className="mc-num">{formatMoney(last.revenue, setup.currency)}</dd>
        </div>
        <div>
          <dt>Payments</dt>
          <dd className="mc-num">{formatCount(last.payments)}</dd>
        </div>
        <div>
          <dt>Refunds</dt>
          <dd className="mc-num">{formatCount(last.refunds)}</dd>
        </div>
        <div>
          <dt>Paying people</dt>
          <dd className="mc-num">{formatCount(last.payers)}</dd>
        </div>
      </dl>
      <ul className="mc-at3-status">
        {fromEvents + fromStores > 0 && (
          <li>
            {[
              fromEvents > 0 && `${plural(fromEvents, 'payment')} from your apps and website`,
              fromStores > 0 &&
                `${plural(fromStores, 'payment')} from ${connected.length === 1 ? STORE_NAMES[connected[0].provider] : 'your store tool'}`,
            ]
              .filter(Boolean)
              .join(', ')}
            .
          </li>
        )}
        <li>
          {connected.length > 0 ? (
            <>
              {connected.map((store) => STORE_NAMES[store.provider]).join(' and ')}{' '}
              {connected.length === 1 ? 'is' : 'are'} connected: App Store and Google Play purchases
              count on their own.
            </>
          ) : (
            <>
              No store tool connected. Using RevenueCat or Adapty? Connect it in {connections} and
              App Store and Google Play purchases count on their own.
            </>
          )}
        </li>
        <li>
          {setup.rates_day
            ? `Other currencies are turned into ${setup.currency} at the European Central Bank's daily rates, the latest from ${plainDate(setup.rates_day, 'long')}.`
            : `Payments in other currencies than ${setup.currency} are counted once the European Central Bank's daily rates arrive.`}
        </li>
      </ul>
      {noRate && (
        <p className="mc-warning-text mc-attr-warning">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            The European Central Bank has no daily rate for {setup.currency}, so payments and spend
            in other currencies are left out. To count them, choose a currency such as USD under
            Revenue currency.
          </span>
        </p>
      )}
      {last.unconverted > 0 && !noRate && (
        <p className="mc-warning-text mc-attr-warning">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>{unconvertedNote({ revenue: last.unconverted, cost: 0, currencies: [] })}</span>
        </p>
      )}
      {setup.skipped_7d.length > 0 && (
        <div className="mc-at3-skipped" role="group" aria-label="Payments not counted">
          <p className="mc-warning-text mc-attr-warning">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>Not counted in the last 7 days:</span>
          </p>
          <ul>
            {setup.skipped_7d.map((item) => (
              <li key={item.reason}>
                {plural(item.events, 'payment')} {skipReason(item.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

type EventDraft = {
  event: string
  amount_property: string
  minor: boolean
  /** 'property' when the event names its currency, else the one currency it is always in. */
  currency: string
  currency_property: string
}

const draftOf = (item: RevenueEvent, fallback: string): EventDraft => ({
  event: item.event,
  amount_property: item.amount_property,
  minor: item.unit === 'minor',
  currency: item.currency_property ? 'property' : (item.currency ?? fallback),
  currency_property: item.currency_property ?? '',
})

const eventOf = (draft: EventDraft): RevenueEvent => ({
  event: draft.event.trim(),
  amount_property: draft.amount_property.trim(),
  unit: draft.minor ? 'minor' : 'major',
  currency_property: draft.currency === 'property' ? draft.currency_property.trim() : null,
  currency: draft.currency === 'property' ? null : draft.currency,
})

function PaymentEvents({
  project,
  view,
  role,
  setup,
  onSaved,
}: {
  project: Project
  view: Attribution
  role?: Role
  setup: RevenueSetup
  onSaved: () => Promise<void>
}) {
  const { notify } = useStore()
  const canEdit = canDo(role, 'developer')
  const listId = useId()
  const [drafts, setDrafts] = useState(() =>
    setup.events.map((item) => draftOf(item, setup.currency)),
  )
  const [errors, setErrors] = useState<Map<number, RevenueEventErrors>>(new Map())
  const action = useAction()
  const events = drafts.map(eventOf)
  const changed = JSON.stringify(events) !== JSON.stringify(setup.events)
  const full = drafts.length >= MAX_REVENUE_EVENTS
  const names = view.events.map((event) => event.name).filter((name) => !name.startsWith('$'))
  const currencies = CURRENCIES.some((item) => item.value === setup.currency)
    ? CURRENCIES
    : [{ value: setup.currency, label: setup.currency }, ...CURRENCIES]

  const change = (index: number, patch: Partial<EventDraft>) =>
    setDrafts((current) =>
      current.map((draft, place) => (place === index ? { ...draft, ...patch } : draft)),
    )

  const remove = (index: number) => {
    setDrafts((current) => current.filter((_, place) => place !== index))
    setErrors(new Map())
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    const found = checkRevenueEvents(events)
    setErrors(found)
    if (found.size) return
    void action.run(async () => {
      await api.saveRevenueEvents(project.id, events)
      await onSaved()
      notify(
        events.length ? `${plural(events.length, 'payment event')} saved` : 'Payment events saved',
      )
    })
  }

  return (
    <form className="mc-panel" onSubmit={save} noValidate>
      <fieldset className="mc-form-stack" disabled={!canEdit}>
        <legend className="mc-attr-legend">
          <span>Payment events</span>
          <span className="mc-muted mc-num">
            {drafts.length} of {MAX_REVENUE_EVENTS}
          </span>
        </legend>
        {drafts.length === 0 && (
          <p className="mc-muted">
            None listed. Payments sent with the revenue call need no entry here.
          </p>
        )}
        {names.length > 0 && (
          <datalist id={listId}>
            {names.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
        {drafts.map((draft, index) => {
          const problem = errors.get(index) ?? {}
          const name = draft.event.trim() || `payment event ${index + 1}`
          return (
            // Rows have no id of their own until saved; the place in the list is the identity.
            // oxlint-disable-next-line react/no-array-index-key
            <div key={index} className="mc-at3-event" role="group" aria-label={name}>
              <div className="mc-at3-event-fields">
                <Field label="Event" error={problem.event}>
                  {(props) => (
                    <input
                      {...props}
                      value={draft.event}
                      list={names.length ? listId : undefined}
                      placeholder="purchase_completed"
                      maxLength={80}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(input) => change(index, { event: input.target.value })}
                    />
                  )}
                </Field>
                <Field label="Amount property" error={problem.amount_property}>
                  {(props) => (
                    <input
                      {...props}
                      value={draft.amount_property}
                      placeholder="value"
                      maxLength={80}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(input) => change(index, { amount_property: input.target.value })}
                    />
                  )}
                </Field>
                <Select
                  label="Currency"
                  value={draft.currency}
                  onChange={(value) => change(index, { currency: value })}
                  options={[
                    { value: 'property', label: 'Named in a property' },
                    ...currencies.map((item) => ({
                      value: item.value,
                      label: `Always ${item.value}`,
                    })),
                  ]}
                />
                {draft.currency === 'property' && (
                  <Field label="Currency property" error={problem.currency_property}>
                    {(props) => (
                      <input
                        {...props}
                        value={draft.currency_property}
                        placeholder="currency"
                        maxLength={80}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(input) =>
                          change(index, { currency_property: input.target.value })
                        }
                      />
                    )}
                  </Field>
                )}
              </div>
              {problem.currency && (
                <p className="mc-field-error" role="alert">
                  {problem.currency}
                </p>
              )}
              <div className="mc-at3-event-foot">
                <label className="mc-check">
                  <input
                    type="checkbox"
                    checked={draft.minor}
                    onChange={(input) => change(index, { minor: input.target.checked })}
                  />
                  <span>
                    Amount is in cents
                    <span className="mc-sub">499 means 4.99</span>
                  </span>
                </label>
                {canEdit && (
                  <button
                    type="button"
                    className="mc-btn mc-btn-quiet"
                    aria-label={`Remove ${name}`}
                    onClick={() => remove(index)}
                  >
                    <Trash2 size={16} aria-hidden="true" /> Remove
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </fieldset>
      {canEdit ? (
        <div className="mc-form-actions mc-at3-event-actions">
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            disabled={full}
            onClick={() =>
              setDrafts((current) => [
                ...current,
                {
                  event: '',
                  amount_property: '',
                  minor: false,
                  currency: 'property',
                  currency_property: '',
                },
              ])
            }
          >
            <Plus size={16} aria-hidden="true" /> Add a payment event
          </button>
          <button
            type="submit"
            className="mc-btn mc-btn-primary"
            disabled={!changed || action.busy}
          >
            Save payment events
          </button>
        </div>
      ) : (
        <p className="mc-muted mc-at3-readonly">
          Developers, admins and the owner can change payment events.
        </p>
      )}
    </form>
  )
}

// Setup > Track revenue ---------------------------------------------------------------------

type RevenuePlatform = 'web' | 'ios' | 'android' | 'react-native' | 'flutter' | 'server'

const revenueTabs: Array<{ value: RevenuePlatform; label: string }> = [
  { value: 'web', label: 'Website' },
  { value: 'ios', label: 'iOS' },
  { value: 'android', label: 'Android' },
  { value: 'react-native', label: 'React Native' },
  { value: 'flutter', label: 'Flutter' },
  { value: 'server', label: 'Server' },
]

const codeLabels: Record<RevenuePlatform, string> = {
  web: 'JavaScript',
  ios: 'Swift',
  android: 'Kotlin',
  'react-native': 'TypeScript',
  flutter: 'Dart',
  server: 'Terminal',
}

/** Step of attribution setup: send each payment with the SDK's revenue call. */
export function TrackRevenueStep({
  project,
  revenue,
}: {
  project: Project
  revenue: RpcState<RevenueSetup>
}) {
  const { now } = useStore()
  const [platform, setPlatform] = useState<RevenuePlatform>(() =>
    project.platforms.includes('ios')
      ? 'ios'
      : project.platforms.includes('android')
        ? 'android'
        : 'web',
  )
  const code = revenueSnippets()
  const snippet =
    platform === 'react-native'
      ? code.reactNative
      : platform === 'flutter'
        ? code.flutter
        : code[platform]
  const setup = revenue.data
  const settingsLink = (
    <a
      className="mc-link"
      href={href({ name: 'attribution', projectId: project.id, section: 'settings' })}
    >
      name it in Settings
    </a>
  )

  return (
    <div className="mc-at2-sdk">
      <div className="mc-panel">
        <p className="mc-at2-lead">
          {setup?.last_received_at && (
            <strong>
              Last payment{' '}
              {formatAgo(setup.last_received_at, Math.max(now, Date.parse(setup.last_received_at)))}
              .{' '}
            </strong>
          )}
          Send each payment with its amount and currency, and ROI shows what every source earned
          back. Already send purchases as an event? You can {settingsLink} instead.
        </p>
        <Segmented
          label="Payments are made in"
          value={platform}
          onChange={setPlatform}
          options={revenueTabs}
        />
        <ol className="mc-at2-steps">
          <li>
            <h3>
              {platform === 'server' ? 'Send each payment from your server' : 'Send each payment'}
            </h3>
            <p className="mc-muted">
              {platform === 'server'
                ? 'With a server key, send the payment as an event for the person who paid. The kma_revenue and kma_currency properties make it a payment.'
                : platform === 'web'
                  ? 'Once a payment succeeds, with the amount the customer paid and its currency. Payments count for the person signed in with identify.'
                  : 'Once a purchase succeeds, with the amount the customer paid and its currency. Payments count for the person signed in with identify.'}
            </p>
            <CodeBlock label={codeLabels[platform]} code={snippet} />
          </li>
          <li>
            <h3>Refunds and repeats</h3>
            <p className="mc-muted">
              A refund is the same call with a negative amount. Give each payment its order or
              transaction ID: a payment sent twice, or also reported by RevenueCat or Adapty, counts
              once.
            </p>
          </li>
        </ol>
        <RevenueWaiting project={project} revenue={revenue} />
      </div>
    </div>
  )
}

function RevenueWaiting({
  project,
  revenue,
}: {
  project: Project
  revenue: RpcState<RevenueSetup>
}) {
  const { now } = useStore()
  const setup = revenue.data
  if (revenue.error && !setup)
    return <ErrorNote message={revenue.error} onRetry={() => void revenue.refresh()} />
  if (!setup) return <Skeleton width="100%" height={20} />
  if (setup.last_received_at)
    return (
      <p className="mc-at3-revenue-note">
        {plural(setup.last_7d.payments, 'payment')} in the last 7 days.{' '}
        <a
          className="mc-link"
          href={href({ name: 'attribution', projectId: project.id, section: 'roi' })}
        >
          See ROI
        </a>
      </p>
    )
  return (
    <p className="mc-at3-revenue-note mc-muted">
      Waiting for the first payment.
      {setup.last_development_at &&
        ` A payment sent with a development key arrived ${formatAgo(setup.last_development_at, Math.max(now, Date.parse(setup.last_development_at)))}; development payments are kept out of reports.`}{' '}
      <button type="button" className="mc-link" onClick={() => void revenue.refresh()}>
        Check again
      </button>
    </p>
  )
}
