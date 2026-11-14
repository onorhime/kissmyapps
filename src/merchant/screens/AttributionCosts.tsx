import { useId, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import {
  Download,
  FileSpreadsheet,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react'
import { api } from '../api'
import type {
  Attribution,
  CostImport,
  CostRow,
  CostRule,
  CostRuleKind,
  CostsReport,
  MoneyRange,
  Project,
  Role,
} from '../api'
import { CURRENCIES, hasApp, sourceLabel } from '../attribution'
import { downloadCsv } from '../csv'
import { formatAgo, formatCount, plural } from '../format'
import { rangePhrase } from '../ranges'
import {
  COST_COLUMNS,
  COST_SOURCE_SUGGESTIONS,
  ECB_CURRENCIES,
  addDays,
  checkCostDraft,
  formatMoney,
  formatMoneyTile,
  linkCostTotals,
  moneyRangeOptions,
  parseAmount,
  parseCostCsv,
  parseDay,
  plainDate,
  todayIn,
  unconvertedNote,
} from '../roi'
import type { CostDraft, CostDraftErrors, ParsedCosts } from '../roi'
import { canDo, useStore } from '../store'
import {
  Empty,
  ErrorNote,
  Field,
  Panel,
  Pill,
  Segmented,
  Select,
  ShowMore,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

type Open = 'add' | 'upload' | null
const PAGE = 50

/** The currencies to choose from, with the one already chosen first if it is not listed. */
function currencyOptions(current: string) {
  return CURRENCIES.some((item) => item.value === current)
    ? CURRENCIES
    : [{ value: current, label: current }, ...CURRENCIES]
}

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
  return { busy, error, run, clear: () => setError(undefined) }
}

export function CostsScreen({
  project,
  view,
  role,
}: {
  project: Project
  view: Attribution
  role?: Role
}) {
  const { now } = useStore()
  const canEdit = canDo(role, 'developer')
  const [range, setRange] = useState<MoneyRange>('30d')
  const [source, setSource] = useState('')
  const [open, setOpen] = useState<Open>(null)
  const report = useRpc(`attribution-costs:${project.id}:${range}:${source}`, () =>
    api.attributionCosts(project.id, { range, ...(source ? { source } : {}) }),
  )
  const data = report.data
  const currency = data?.currency ?? view.settings?.currency ?? 'USD'
  const today = todayIn(project.timezone, now)
  const sources = [...new Set([...(data?.sources ?? []), ...COST_SOURCE_SUGGESTIONS])]

  return (
    <>
      <div className="mc-toolbar">
        <Segmented
          label="Date range"
          value={range}
          onChange={setRange}
          options={moneyRangeOptions}
        />
        <Select
          label="Source"
          hideLabel
          value={source}
          onChange={setSource}
          options={[
            { value: '', label: 'All sources' },
            ...[...new Set([...(data?.sources ?? []), ...(source ? [source] : [])])].map(
              (value) => ({ value, label: sourceLabel(value) }),
            ),
          ]}
        />
        {canEdit && (
          <span className="mc-at3-actions mc-toolbar-end">
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              aria-expanded={open === 'upload'}
              onClick={() => setOpen(open === 'upload' ? null : 'upload')}
            >
              <FileSpreadsheet size={16} aria-hidden="true" /> Upload CSV
            </button>
            <button
              type="button"
              className="mc-btn mc-btn-primary"
              aria-expanded={open === 'add'}
              onClick={() => setOpen(open === 'add' ? null : 'add')}
            >
              <Plus size={16} aria-hidden="true" /> Add spend
            </button>
          </span>
        )}
      </div>

      {report.error && (
        <ErrorNote
          message={`Couldn't load your spend. ${report.error}`}
          onRetry={() => void report.refresh()}
        />
      )}

      {canEdit && open === 'add' && (
        <AddSpend
          project={project}
          currency={currency}
          today={today}
          sources={sources}
          onClose={() => setOpen(null)}
          onSaved={report.refresh}
        />
      )}
      {canEdit && open === 'upload' && (
        <Upload
          project={project}
          currency={currency}
          onClose={() => setOpen(null)}
          onSaved={report.refresh}
        />
      )}

      <Totals report={data} currency={currency} />
      {!canEdit && (
        <p className="mc-muted mc-attr-note">
          Developers, admins and the owner can add, upload and change spend.
        </p>
      )}

      <SpendTable
        key={`${range}:${source}`}
        project={project}
        report={data}
        range={range}
        source={source}
        canEdit={canEdit}
        onChanged={report.refresh}
        onAdd={() => setOpen('add')}
      />

      <LinkPrices
        project={project}
        view={view}
        report={data}
        currency={currency}
        today={today}
        canEdit={canEdit}
        onChanged={report.refresh}
      />

      {data && data.imports.length > 0 && (
        <Uploads project={project} report={data} canEdit={canEdit} onChanged={report.refresh} />
      )}
    </>
  )
}

/**
 * The currencies of typed and uploaded spend that the European Central Bank has no rate for.
 * Only named when the project's own currency has rates, as otherwise every other one is missing.
 */
function rateless(report: CostsReport, currency: string): string[] {
  if (!ECB_CURRENCIES.has(currency)) return []
  return [
    ...new Set(
      report.rows.flatMap((row) =>
        row.currency !== currency && !ECB_CURRENCIES.has(row.currency) ? [row.currency] : [],
      ),
    ),
  ].sort()
}

function Totals({ report, currency }: { report: CostsReport | undefined; currency: string }) {
  const totals = report?.totals
  const tiles: Array<[string, number | undefined, string]> = [
    ['Spend', totals?.cost, report ? rangePhrase[report.range] : ''],
    ['Typed in', totals?.typed, 'added here by hand'],
    ['Uploaded', totals?.uploaded, 'from spreadsheets'],
    ['Link prices', totals?.links, 'per install or click'],
  ]
  return (
    <>
      <div className="mc-kpis mc-kpis-4" role="group" aria-label="Spend totals">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="mc-kpi">
            <span className="mc-kpi-label">{label}</span>
            <strong className="mc-kpi-value">
              {value === undefined ? (
                <Skeleton width={72} height={28} />
              ) : (
                formatMoneyTile(value, currency)
              )}
            </strong>
            <span className="mc-sub">{sub}</span>
          </div>
        ))}
      </div>
      {report && report.totals.unconverted > 0 && (
        <p className="mc-warning-text mc-attr-warning">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            {unconvertedNote({
              revenue: 0,
              cost: report.totals.unconverted,
              currencies: rateless(report, currency),
            })}
          </span>
        </p>
      )}
    </>
  )
}

// Spend rows --------------------------------------------------------------------------------

function originLabel(row: CostRow, imports: CostImport[]): { text: string; detail?: string } {
  if (row.origin === 'csv') {
    const file = imports.find((item) => item.id === row.import_id)?.file_name
    return { text: 'Uploaded', detail: file ?? undefined }
  }
  if (row.origin === 'meta') return { text: 'From Meta' }
  if (row.origin === 'tiktok') return { text: 'From TikTok' }
  return { text: 'Typed in' }
}

function SpendTable({
  project,
  report,
  range,
  source,
  canEdit,
  onChanged,
  onAdd,
}: {
  project: Project
  report: CostsReport | undefined
  range: MoneyRange
  source: string
  canEdit: boolean
  onChanged: () => Promise<void>
  onAdd: () => void
}) {
  const { notify } = useStore()
  const [shown, setShown] = useState(PAGE)
  const [editing, setEditing] = useState<{ id: string; amount: string; error?: string } | null>(
    null,
  )
  const [confirming, setConfirming] = useState<string | null>(null)
  const action = useAction()
  const rows = report?.rows ?? []

  const saveAmount = (row: CostRow) => {
    if (!editing) return
    const amount = parseAmount(editing.amount)
    if (amount === null || amount < 0 || amount > 1_000_000_000) {
      setEditing({ ...editing, error: 'Enter what was spent, such as 120.50.' })
      return
    }
    void action.run(async () => {
      await api.saveCosts(project.id, [
        {
          id: row.id,
          day: row.day,
          source: row.source,
          ...(row.campaign ? { campaign: row.campaign } : {}),
          ...(row.adset ? { adset: row.adset } : {}),
          ...(row.ad ? { ad: row.ad } : {}),
          amount,
          currency: row.currency,
        },
      ])
      setEditing(null)
      await onChanged()
      notify(`Spend for ${sourceLabel(row.source)} on ${plainDate(row.day)} saved`)
    })
  }

  const remove = (row: CostRow) =>
    void action.run(async () => {
      await api.deleteCosts(project.id, [row.id])
      setConfirming(null)
      await onChanged()
      notify(`Spend for ${sourceLabel(row.source)} on ${plainDate(row.day)} deleted`)
    })

  return (
    <Panel
      title="Spend by day"
      description={`What you typed in and uploaded ${rangePhrase[range]}, newest day first, in the currency it was added in.`}
      id="mc-at3-costs"
      flush
    >
      {!report ? (
        <div className="mc-table-loading" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} width="100%" height={28} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mc-attr-empty">
          <Empty>
            {source
              ? `No spend for ${sourceLabel(source)} ${rangePhrase[range]}.`
              : `No spend added ${rangePhrase[range]}. Add what each campaign cost per day, or upload the spreadsheet your ad account exports, to see what it earned back in ROI.`}
          </Empty>
          {canEdit && !source && (
            <button type="button" className="mc-btn mc-btn-secondary" onClick={onAdd}>
              <Plus size={16} aria-hidden="true" /> Add your first spend
            </button>
          )}
        </div>
      ) : (
        <>
          <table className="mc-table mc-at3-costs-table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Source</th>
                <th scope="col">Campaign</th>
                <th scope="col" className="mc-num-col">
                  Amount
                </th>
                <th scope="col">Added</th>
                {canEdit && (
                  <th scope="col" className="is-action">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((row) => {
                const origin = originLabel(row, report.imports)
                const isEditing = editing?.id === row.id
                const name = `${sourceLabel(row.source)} on ${plainDate(row.day)}`
                return (
                  <tr key={row.id}>
                    <td data-label="Day" className="mc-num">
                      {plainDate(row.day, 'long')}
                    </td>
                    <td data-label="Source">{sourceLabel(row.source)}</td>
                    <td data-label="Campaign">
                      {row.campaign ? (
                        <>
                          <span className="mc-truncate">{row.campaign}</span>
                          {(row.adset || row.ad) && (
                            <span className="mc-sub mc-truncate">
                              {[row.adset, row.ad].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="mc-muted">All campaigns</span>
                      )}
                    </td>
                    <td data-label="Amount" className="mc-num mc-num-col">
                      {isEditing ? (
                        <form
                          className="mc-at3-inline-edit"
                          noValidate
                          onSubmit={(event) => {
                            event.preventDefault()
                            saveAmount(row)
                          }}
                        >
                          <label className="sr-only" htmlFor={`mc-at3-amount-${row.id}`}>
                            Amount for {name}, in {row.currency}
                          </label>
                          <input
                            id={`mc-at3-amount-${row.id}`}
                            value={editing.amount}
                            inputMode="decimal"
                            autoComplete="off"
                            // The field opened by choosing Edit takes the focus.
                            // oxlint-disable-next-line jsx-a11y/no-autofocus
                            autoFocus
                            aria-invalid={editing.error ? true : undefined}
                            aria-describedby={
                              editing.error ? `mc-at3-amount-${row.id}-error` : undefined
                            }
                            onChange={(event) =>
                              setEditing({ id: row.id, amount: event.target.value })
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') setEditing(null)
                            }}
                          />
                          <span className="mc-muted">{row.currency}</span>
                          <button
                            type="submit"
                            className="mc-btn mc-btn-primary"
                            disabled={action.busy}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="mc-icon-btn"
                            aria-label="Cancel"
                            onClick={() => setEditing(null)}
                          >
                            <X size={16} aria-hidden="true" />
                          </button>
                          {editing.error && (
                            <span
                              id={`mc-at3-amount-${row.id}-error`}
                              className="mc-field-error"
                              role="alert"
                            >
                              {editing.error}
                            </span>
                          )}
                        </form>
                      ) : (
                        formatMoney(row.amount, row.currency)
                      )}
                    </td>
                    <td data-label="Added">
                      <span>{origin.text}</span>
                      {origin.detail && <span className="mc-sub mc-truncate">{origin.detail}</span>}
                    </td>
                    {canEdit && (
                      <td className="is-action">
                        {confirming === row.id ? (
                          <span className="mc-attr-confirm mc-at3-confirm">
                            <span>Delete this spend?</span>
                            <button
                              type="button"
                              className="mc-btn mc-btn-secondary"
                              onClick={() => setConfirming(null)}
                            >
                              Keep it
                            </button>
                            <button
                              type="button"
                              className="mc-btn mc-btn-danger-solid"
                              disabled={action.busy}
                              onClick={() => remove(row)}
                            >
                              Delete
                            </button>
                          </span>
                        ) : (
                          <span className="mc-row-actions">
                            <button
                              type="button"
                              className="mc-icon-btn"
                              aria-label={`Change the amount for ${name}`}
                              title="Change the amount"
                              onClick={() => {
                                setConfirming(null)
                                setEditing({ id: row.id, amount: String(row.amount) })
                              }}
                            >
                              <Pencil size={18} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="mc-icon-btn"
                              aria-label={`Delete the spend for ${name}`}
                              title="Delete"
                              onClick={() => {
                                setEditing(null)
                                setConfirming(row.id)
                              }}
                            >
                              <Trash2 size={18} aria-hidden="true" />
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="mc-panel-foot is-padded">
            <ShowMore
              shown={Math.min(shown, rows.length)}
              total={rows.length}
              noun="spend rows"
              onMore={() => setShown((current) => current + PAGE)}
            />
          </div>
        </>
      )}
    </Panel>
  )
}

// Adding spend --------------------------------------------------------------------------------

function AddSpend({
  project,
  currency,
  today,
  sources,
  onClose,
  onSaved,
}: {
  project: Project
  currency: string
  today: string
  sources: string[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { notify } = useStore()
  const id = useId()
  const [draft, setDraft] = useState<CostDraft>({
    day: today,
    source: '',
    campaign: '',
    adset: '',
    ad: '',
    amount: '',
    currency,
  })
  const [errors, setErrors] = useState<CostDraftErrors>({})
  const action = useAction()
  const set = (key: keyof CostDraft) => (event: ChangeEvent<HTMLInputElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }))

  const save = (event: FormEvent) => {
    event.preventDefault()
    const checked = checkCostDraft(draft, today)
    setErrors(checked.errors)
    const input = checked.input
    if (!input) return
    void action.run(async () => {
      await api.saveCosts(project.id, [input])
      await onSaved()
      notify(`Spend for ${sourceLabel(input.source)} on ${plainDate(input.day)} saved`)
      // The next day's spend for the same campaign is the usual next entry.
      setDraft((current) => ({ ...current, amount: '' }))
    })
  }

  const text = (key: 'source' | 'campaign' | 'adset' | 'ad', label: string, hint: string) => (
    <Field label={label} hint={hint} error={errors[key]}>
      {(props) => (
        <input
          {...props}
          value={draft[key]}
          maxLength={key === 'source' ? 60 : 200}
          list={key === 'source' ? `${id}-sources` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            key === 'source'
              ? 'meta'
              : key === 'campaign'
                ? 'spring_sale'
                : key === 'adset'
                  ? 'lagos_18_24'
                  : 'video_1'
          }
          onChange={set(key)}
        />
      )}
    </Field>
  )

  return (
    <form className="mc-panel" onSubmit={save} noValidate aria-labelledby={`${id}-title`}>
      <div className="mc-panel-head mc-at3-form-head">
        <div>
          <h2 id={`${id}-title`}>Add spend</h2>
          <p>
            What one source and campaign cost on one day. Adding the same day and names again
            replaces the amount.
          </p>
        </div>
        <button type="button" className="mc-icon-btn" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="mc-form-grid">
        <Field label="Day" error={errors.day}>
          {(props) => (
            <input
              {...props}
              type="date"
              value={draft.day}
              max={today}
              min={addDays(today, -730)}
              onChange={set('day')}
            />
          )}
        </Field>
        {text('source', 'Source', 'Who you paid: meta, tiktok, google_ads or a creator’s name.')}
        <datalist id={`${id}-sources`}>
          {sources.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        {text(
          'campaign',
          'Campaign',
          'Optional. The campaign name your links or ad tags carry, so spend meets the people it brought.',
        )}
        {text('adset', 'Ad set', 'Optional, under a campaign.')}
        {text('ad', 'Ad', 'Optional, under an ad set.')}
        <div className="mc-at3-amount">
          <Field label="Amount" error={errors.amount}>
            {(props) => (
              <input
                {...props}
                value={draft.amount}
                inputMode="decimal"
                autoComplete="off"
                placeholder="120.50"
                onChange={set('amount')}
              />
            )}
          </Field>
          <Select
            label="Currency"
            value={draft.currency}
            onChange={(value) => setDraft((current) => ({ ...current, currency: value }))}
            options={currencyOptions(draft.currency)}
          />
        </div>
      </div>
      <div className="mc-form-actions">
        {action.error && (
          <p className="mc-field-error mc-attr-form-error" role="alert">
            {action.error}
          </p>
        )}
        <button type="button" className="mc-btn mc-btn-secondary" onClick={onClose}>
          Done
        </button>
        <button type="submit" className="mc-btn mc-btn-primary" disabled={action.busy}>
          {action.busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
          Save spend
        </button>
      </div>
    </form>
  )
}

// Uploading a spreadsheet ---------------------------------------------------------------------

function Upload({
  project,
  currency,
  onClose,
  onSaved,
}: {
  project: Project
  currency: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { notify } = useStore()
  const id = useId()
  const [file, setFile] = useState<{ name: string; parsed: ParsedCosts } | null>(null)
  const [refused, setRefused] = useState<Array<{ line: number; message: string }>>([])
  const action = useAction()
  const parsed = file?.parsed
  const ready = Boolean(parsed && !parsed.problem && !parsed.errors.length && parsed.rows.length)

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]
    // The same file can be chosen again after it is fixed.
    event.target.value = ''
    if (!chosen) return
    setRefused([])
    action.clear()
    try {
      setFile({ name: chosen.name, parsed: parseCostCsv(await chosen.text()) })
    } catch {
      setFile({
        name: chosen.name,
        parsed: { rows: [], errors: [], problem: 'The file could not be read.' },
      })
    }
  }

  const upload = () => {
    if (!file || !parsed || !ready) return
    void action.run(async () => {
      const result = await api.importCosts(project.id, {
        file_name: file.name.slice(0, 200),
        rows: parsed.rows.map((row) => row.input),
      })
      if (result.errors.length || !result.import_id) {
        // Rows are counted from the first row sent; the file's lines include its heading.
        setRefused(
          result.errors.map((error) => ({
            line: parsed.rows[error.row - 1]?.line ?? error.row + 1,
            message: error.message,
          })),
        )
        return
      }
      setFile(null)
      await onSaved()
      notify(
        `${plural(result.imported, 'row')} uploaded${result.replaced ? `, ${formatCount(result.replaced)} replacing spend already there` : ''}`,
      )
      onClose()
    })
  }

  const problems = parsed?.errors.length ? parsed.errors : refused
  return (
    <section className="mc-panel" aria-labelledby={`${id}-title`}>
      <div className="mc-panel-head mc-at3-form-head">
        <div>
          <h2 id={`${id}-title`}>Upload spend</h2>
          <p>
            A CSV file with one row per day and campaign, such as your ad account&rsquo;s daily
            export. Rows for a day and names already there replace them. Without a currency column,
            amounts are in {currency}.
          </p>
        </div>
        <button type="button" className="mc-icon-btn" aria-label="Close" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="mc-at3-upload-actions">
        <label className="mc-btn mc-btn-secondary mc-at3-file">
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(event) => void choose(event)}
          />
          <FileSpreadsheet size={16} aria-hidden="true" />{' '}
          {file ? 'Choose another file' : 'Choose a CSV file'}
        </label>
        <button
          type="button"
          className="mc-btn mc-btn-quiet"
          onClick={() => downloadCsv('spend-template.csv', [COST_COLUMNS])}
        >
          <Download size={16} aria-hidden="true" /> Download the template
        </button>
      </div>
      <p className="mc-field-hint">
        Columns: <span className="mc-mono">{COST_COLUMNS.join(',')}</span>. Day is YYYY-MM-DD; date
        works too, and spend or cost for amount. Day, source and amount are needed.
      </p>

      {parsed?.problem && (
        <p className="mc-warning-text mc-attr-warning" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>
            {file?.name}: {parsed.problem}
          </span>
        </p>
      )}

      {parsed && !parsed.problem && (
        <>
          <p className="mc-at3-upload-summary">
            <strong>{file?.name}</strong>{' '}
            <span className="mc-muted">
              {plural(parsed.rows.length + parsed.errors.length, 'row')}
              {parsed.errors.length ? `, ${plural(parsed.errors.length, 'line')} to fix` : ''}
            </span>
          </p>
          {parsed.rows.length > 0 && (
            <div className="mc-at3-preview">
              <table className="mc-table mc-at3-preview-table">
                <caption className="sr-only">The first rows of the file</caption>
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col">Day</th>
                    <th scope="col">Source</th>
                    <th scope="col">Campaign</th>
                    <th scope="col">Ad set</th>
                    <th scope="col">Ad</th>
                    <th scope="col" className="mc-num-col">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((row) => (
                    <tr key={row.line}>
                      <td data-label="Line" className="mc-num mc-muted">
                        {row.line}
                      </td>
                      <td data-label="Day" className="mc-num">
                        {row.input.day}
                      </td>
                      <td data-label="Source">{row.input.source}</td>
                      <td data-label="Campaign">{row.input.campaign ?? '—'}</td>
                      <td data-label="Ad set">{row.input.adset ?? '—'}</td>
                      <td data-label="Ad">{row.input.ad ?? '—'}</td>
                      <td data-label="Amount" className="mc-num mc-num-col">
                        {formatMoney(row.input.amount, row.input.currency ?? currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 5 && (
                <p className="mc-muted mc-at3-preview-more">
                  And {plural(parsed.rows.length - 5, 'more row')}.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {problems.length > 0 && (
        <div className="mc-at3-problems" role="alert">
          <p>
            {parsed?.errors.length
              ? 'Fix these lines in the file and choose it again. Nothing was uploaded.'
              : 'Nothing was uploaded. Fix these lines in the file and choose it again:'}
          </p>
          <ul>
            {problems.slice(0, 20).map((problem) => (
              <li key={`${problem.line}:${problem.message}`}>
                <strong>Line {problem.line}</strong> {problem.message}
              </li>
            ))}
          </ul>
          {problems.length > 20 && (
            <p className="mc-muted">And {plural(problems.length - 20, 'more line')}.</p>
          )}
        </div>
      )}

      <div className="mc-form-actions">
        {action.error && (
          <p className="mc-field-error mc-attr-form-error" role="alert">
            {action.error}
          </p>
        )}
        <button type="button" className="mc-btn mc-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="mc-btn mc-btn-primary"
          disabled={!ready || action.busy || refused.length > 0}
          onClick={upload}
        >
          {action.busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
          {parsed && ready ? `Upload ${plural(parsed.rows.length, 'row')}` : 'Upload'}
        </button>
      </div>
    </section>
  )
}

function Uploads({
  project,
  report,
  canEdit,
  onChanged,
}: {
  project: Project
  report: CostsReport
  canEdit: boolean
  onChanged: () => Promise<void>
}) {
  const { notify, now } = useStore()
  const [confirming, setConfirming] = useState<string | null>(null)
  const action = useAction()
  return (
    <Panel
      title="Recent uploads"
      description="Undo an upload to delete the rows still from it."
      id="mc-at3-uploads"
    >
      <ul className="mc-at3-uploads">
        {report.imports.map((item) => {
          const name = item.file_name ?? 'An upload'
          return (
            <li key={item.id}>
              <span className="mc-at3-upload-text">
                <strong className="mc-truncate">{name}</strong>
                <span className="mc-sub">
                  {plural(item.rows, 'row')}
                  {item.created_at
                    ? `, uploaded ${formatAgo(item.created_at, Math.max(now, Date.parse(item.created_at)))}`
                    : ''}
                  {item.remaining < item.rows
                    ? `. ${formatCount(item.remaining)} still from this file; the rest were changed or replaced since.`
                    : ''}
                </span>
              </span>
              {canEdit &&
                (confirming === item.id ? (
                  <span className="mc-attr-confirm">
                    <span>Delete its {plural(item.remaining, 'row')}?</span>
                    <button
                      type="button"
                      className="mc-btn mc-btn-secondary"
                      onClick={() => setConfirming(null)}
                    >
                      Keep them
                    </button>
                    <button
                      type="button"
                      className="mc-btn mc-btn-danger-solid"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          const deleted = await api.undoCostImport(project.id, item.id)
                          setConfirming(null)
                          await onChanged()
                          notify(`${name} undone: ${plural(deleted, 'row')} deleted`)
                        })
                      }
                    >
                      Undo upload
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="mc-btn mc-btn-quiet"
                    onClick={() => setConfirming(item.id)}
                  >
                    <Undo2 size={16} aria-hidden="true" /> Undo
                  </button>
                ))}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

// Link prices -------------------------------------------------------------------------------

type RuleDraft = {
  link_id: string
  kind: CostRuleKind
  amount: string
  currency: string
  starts_on: string
  ends_on: string
}

type RuleErrors = Partial<Record<keyof RuleDraft, string>>

function LinkPrices({
  project,
  view,
  report,
  currency,
  today,
  canEdit,
  onChanged,
}: {
  project: Project
  view: Attribution
  report: CostsReport | undefined
  currency: string
  today: string
  canEdit: boolean
  onChanged: () => Promise<void>
}) {
  const { notify } = useStore()
  const [editing, setEditing] = useState<CostRule | 'new' | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const action = useAction()
  const rules = report?.rules ?? []
  const added = linkCostTotals(report?.link_costs ?? [])

  return (
    <Panel
      title="Link prices"
      description="A fixed price for each install or click a link brings, for creator and influencer deals. Each day's installs or clicks times the price count as spend."
      id="mc-at3-rules"
      flush
      actions={
        canEdit && editing === null ? (
          <button
            type="button"
            className="mc-btn mc-btn-secondary"
            onClick={() => setEditing('new')}
          >
            <Plus size={16} aria-hidden="true" /> Add a link price
          </button>
        ) : undefined
      }
    >
      {editing !== null && (
        <RuleForm
          key={editing === 'new' ? 'new' : editing.id}
          project={project}
          view={view}
          rule={editing === 'new' ? null : editing}
          rules={rules}
          currency={currency}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await onChanged()
          }}
        />
      )}
      {!report ? (
        <div className="mc-table-loading" aria-hidden="true">
          <Skeleton width="100%" height={28} />
        </div>
      ) : rules.length === 0 ? (
        editing === null && (
          <Empty>
            No link prices. Paying a creator per install or per click? Give their link a price and
            ROI counts it as spend each day.
          </Empty>
        )
      ) : (
        <table className="mc-table mc-at3-rules-table">
          <thead>
            <tr>
              <th scope="col">Link</th>
              <th scope="col" className="mc-num-col">
                Price
              </th>
              <th scope="col">When</th>
              <th scope="col" className="mc-num-col">
                {rangePhrase[report.range].replace(/^in the last/, 'Last')}
              </th>
              {canEdit && (
                <th scope="col" className="is-action">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => {
              const sum = added.get(rule.link_id)
              return (
                <tr key={rule.id}>
                  <td data-label="Link">
                    <strong className="mc-truncate">{rule.link_name}</strong>
                    <span className="mc-sub mc-truncate">
                      {[sourceLabel(rule.link_source), rule.link_campaign]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </td>
                  <td data-label="Price" className="mc-num mc-num-col">
                    {formatMoney(rule.amount, rule.currency)}
                    <span className="mc-sub">per {rule.kind}</span>
                  </td>
                  <td data-label="When">
                    {rule.ends_on
                      ? `${plainDate(rule.starts_on, 'long')} to ${plainDate(rule.ends_on, 'long')}`
                      : `From ${plainDate(rule.starts_on, 'long')}`}
                    {rule.ends_on && rule.ends_on < today && (
                      <span className="mc-sub">
                        <Pill tone="neutral">Ended</Pill>
                      </span>
                    )}
                  </td>
                  <td data-label="In this range" className="mc-num mc-num-col">
                    {sum ? (
                      <>
                        {[...sum.amounts]
                          .map(([code, amount]) => formatMoney(amount, code))
                          .join(' + ')}
                        <span className="mc-sub">{plural(sum.count, rule.kind)}</span>
                      </>
                    ) : (
                      <span className="mc-muted">Nothing yet</span>
                    )}
                  </td>
                  {canEdit && (
                    <td className="is-action">
                      {confirming === rule.id ? (
                        <span className="mc-attr-confirm mc-at3-confirm">
                          <span>Remove this price?</span>
                          <button
                            type="button"
                            className="mc-btn mc-btn-secondary"
                            onClick={() => setConfirming(null)}
                          >
                            Keep it
                          </button>
                          <button
                            type="button"
                            className="mc-btn mc-btn-danger-solid"
                            disabled={action.busy}
                            onClick={() =>
                              void action.run(async () => {
                                await api.deleteCostRule(project.id, rule.id)
                                setConfirming(null)
                                await onChanged()
                                notify(`The price for ${rule.link_name} is removed`)
                              })
                            }
                          >
                            Remove
                          </button>
                        </span>
                      ) : (
                        <span className="mc-row-actions">
                          <button
                            type="button"
                            className="mc-icon-btn"
                            aria-label={`Change the price for ${rule.link_name}`}
                            title="Change"
                            onClick={() => setEditing(rule)}
                          >
                            <Pencil size={18} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="mc-icon-btn"
                            aria-label={`Remove the price for ${rule.link_name}`}
                            title="Remove"
                            onClick={() => setConfirming(rule.id)}
                          >
                            <Trash2 size={18} aria-hidden="true" />
                          </button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

function RuleForm({
  project,
  view,
  rule,
  rules,
  currency,
  today,
  onClose,
  onSaved,
}: {
  project: Project
  view: Attribution
  rule: CostRule | null
  rules: CostRule[]
  currency: string
  today: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { notify } = useStore()
  const id = useId()
  const apps = hasApp(project, view.settings)
  const links = useRpc(`attribution-cost-links:${project.id}`, () =>
    api.attributionLinks(project.id, '7d'),
  )
  const [draft, setDraft] = useState<RuleDraft>(() => ({
    link_id: rule?.link_id ?? '',
    kind: rule?.kind ?? (apps ? 'install' : 'click'),
    amount: rule ? String(rule.amount) : '',
    currency: rule?.currency ?? currency,
    starts_on: rule?.starts_on ?? today,
    ends_on: rule?.ends_on ?? '',
  }))
  const [errors, setErrors] = useState<RuleErrors>({})
  const action = useAction()
  const choices = links.data?.links ?? []
  const priced = new Map(rules.map((item) => [item.link_id, item]))
  // A new price starts on the first link without one.
  const linkId =
    draft.link_id || (choices.find((link) => !priced.has(link.id)) ?? choices[0])?.id || ''
  const replacing = !rule && linkId ? priced.get(linkId) : undefined

  const save = (event: FormEvent) => {
    event.preventDefault()
    const found: RuleErrors = {}
    if (!linkId) found.link_id = 'Choose a link.'
    const amount = parseAmount(draft.amount)
    if (amount === null || amount <= 0) found.amount = 'Enter the price, such as 2.00.'
    else if (amount > 1_000_000) found.amount = 'A price is up to a million.'
    const starts = parseDay(draft.starts_on)
    if (!starts) found.starts_on = 'Choose the first day the price counts.'
    const ends = draft.ends_on.trim() ? parseDay(draft.ends_on) : null
    if (draft.ends_on.trim() && !ends) found.ends_on = 'Choose a day, or leave it empty.'
    else if (ends && starts && ends < starts) found.ends_on = 'The last day comes after the first.'
    setErrors(found)
    if (Object.keys(found).length || amount === null || !starts) return
    void action.run(async () => {
      const saved = await api.saveCostRule(project.id, {
        link_id: linkId,
        kind: draft.kind,
        amount,
        currency: draft.currency,
        starts_on: starts,
        ends_on: ends,
      })
      notify(
        `${saved.link_name} costs ${formatMoney(saved.amount, saved.currency)} per ${saved.kind}`,
      )
      await onSaved()
    })
  }

  return (
    <form className="mc-at3-rule-form" onSubmit={save} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>
        {rule ? `Change the price for ${rule.link_name}` : 'A price for a link'}
      </h3>
      {links.error && !links.data ? (
        <ErrorNote
          message={`Couldn't load your links. ${links.error}`}
          onRetry={() => void links.refresh()}
        />
      ) : !links.data ? (
        <Skeleton width="100%" height={40} />
      ) : choices.length === 0 ? (
        <p className="mc-muted">
          You have no links yet. Make one for the creator in Links, then give it a price here.
        </p>
      ) : (
        <div className="mc-form-grid">
          {rule ? (
            <div className="mc-field">
              <span className="mc-at3-field-label">Link</span>
              <strong>{rule.link_name}</strong>
            </div>
          ) : (
            <div>
              <Select
                label="Link"
                value={linkId}
                onChange={(value) => setDraft((current) => ({ ...current, link_id: value }))}
                options={choices.map((link) => ({
                  value: link.id,
                  label: priced.has(link.id) ? `${link.name} (has a price)` : link.name,
                }))}
              />
              {(errors.link_id || replacing) && (
                <p className={errors.link_id ? 'mc-field-error' : 'mc-field-hint'}>
                  {errors.link_id ??
                    `It costs ${formatMoney(replacing!.amount, replacing!.currency)} per ${replacing!.kind} now; saving replaces that.`}
                </p>
              )}
            </div>
          )}
          <div className="mc-field">
            <span className="mc-at3-field-label" id={`${id}-kind`}>
              Pays for each
            </span>
            <Segmented
              label="Pays for each"
              value={draft.kind}
              onChange={(kind) => setDraft((current) => ({ ...current, kind }))}
              options={[
                { value: 'install', label: 'Install' },
                { value: 'click', label: 'Click' },
              ]}
            />
          </div>
          <div className="mc-at3-amount">
            <Field label="Price" error={errors.amount}>
              {(props) => (
                <input
                  {...props}
                  value={draft.amount}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="2.00"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, amount: event.target.value }))
                  }
                />
              )}
            </Field>
            <Select
              label="Currency"
              value={draft.currency}
              onChange={(value) => setDraft((current) => ({ ...current, currency: value }))}
              options={currencyOptions(draft.currency)}
            />
          </div>
          <div className="mc-at3-dates">
            <Field label="From" error={errors.starts_on}>
              {(props) => (
                <input
                  {...props}
                  type="date"
                  value={draft.starts_on}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, starts_on: event.target.value }))
                  }
                />
              )}
            </Field>
            <Field label="Until" hint="Empty: no end." error={errors.ends_on}>
              {(props) => (
                <input
                  {...props}
                  type="date"
                  value={draft.ends_on}
                  min={draft.starts_on || undefined}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, ends_on: event.target.value }))
                  }
                />
              )}
            </Field>
          </div>
        </div>
      )}
      <div className="mc-form-actions">
        {action.error && (
          <p className="mc-field-error mc-attr-form-error" role="alert">
            {action.error}
          </p>
        )}
        <button type="button" className="mc-btn mc-btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="submit"
          className="mc-btn mc-btn-primary"
          disabled={action.busy || !choices.length}
        >
          Save price
        </button>
      </div>
    </form>
  )
}
