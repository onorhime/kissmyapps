import { useState } from 'react'
import { ShieldCheck, ShieldOff, Wifi } from 'lucide-react'
import { api } from '../api'
import type { BotRule, Project, Range } from '../api'
import {
  botRuleLabels,
  formatCount,
  formatDuration,
  formatPercent,
  placeLabel,
  platformLabels,
  plural,
  timeIn,
} from '../format'
import { rangeOptions, rangePhrase } from '../ranges'
import { href } from '../routes'
import { canDo, useStore } from '../store'
import {
  Empty,
  ErrorNote,
  PageHeader,
  Panel,
  PersonCell,
  Pill,
  Segmented,
  Skeleton,
} from '../ui/Primitives'
import { useRpc } from '../ui/useRpc'

export function BotsScreen({ project }: { project: Project }) {
  const { workspace, notify } = useStore()
  const time = timeIn(project.timezone)
  const [range, setRange] = useState<Range>('7d')
  const report = useRpc(`bots:${project.id}:${range}`, () => api.bots(project.id, range), {
    pollMs: 60_000,
  })
  const [busy, setBusy] = useState<string | null>(null)
  const data = report.data
  const canEdit = canDo(workspace?.role, 'developer')

  const act = async (id: string, action: () => Promise<unknown>, message: string) => {
    setBusy(id)
    try {
      await action()
      notify(message)
      await report.refresh()
    } catch (problem) {
      notify(problem instanceof Error ? problem.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  const totals = data?.totals
  return (
    <div className="mc-page">
      <PageHeader
        title="Bots"
        description={`Automated traffic found in ${project.name} ${rangePhrase[range]}. Sessions caught by a rule are left out of every report.`}
        actions={
          <Segmented label="Date range" value={range} onChange={setRange} options={rangeOptions} />
        }
      />
      {report.error && (
        <ErrorNote
          message={`Couldn't load bot traffic. ${report.error}`}
          onRetry={() => void report.refresh()}
        />
      )}

      <div className="mc-kpis mc-kpis-4" role="group" aria-label="Bot traffic">
        <div className="mc-kpi">
          <span className="mc-kpi-label">Sessions left out</span>
          <strong className="mc-kpi-value mc-num">
            {totals ? formatCount(totals.excluded_sessions) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">
            {totals
              ? `${formatPercent(totals.excluded_sessions, totals.sessions)} of ${formatCount(totals.sessions)} sessions`
              : ''}
          </span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Flagged by a rule</span>
          <strong className="mc-kpi-value mc-num">
            {totals ? formatCount(totals.flagged_sessions) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">including any marked as people</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Visitors left out</span>
          <strong className="mc-kpi-value mc-num">
            {totals ? formatCount(totals.excluded_people) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">not counted as users</span>
        </div>
        <div className="mc-kpi">
          <span className="mc-kpi-label">Events left out</span>
          <strong className="mc-kpi-value mc-num">
            {totals ? formatCount(totals.excluded_events) : <Skeleton width={60} height={28} />}
          </strong>
          <span className="mc-sub">from bot sessions</span>
        </div>
      </div>

      <Panel
        title="Rules"
        description="Turn a rule off to count its sessions as people again. Changes apply to past and new sessions."
        id="mc-bot-rules"
      >
        <ul className="mc-rules">
          {(data?.rules ?? []).map((rule) => {
            const label = botRuleLabels[rule.rule as BotRule]
            return (
              <li key={rule.rule}>
                <div>
                  <strong>{label.name}</strong>
                  <span className="mc-sub">{label.detail}</span>
                </div>
                <span className="mc-num mc-muted">{plural(rule.sessions, 'session')}</span>
                <label className="mc-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={rule.enabled}
                    disabled={!canEdit || busy === rule.rule}
                    onChange={(event) =>
                      void act(
                        rule.rule,
                        () => api.setBotRule(project.id, rule.rule, event.target.checked),
                        `${label.name} ${event.target.checked ? 'on: its sessions are left out' : 'off: its sessions count again'}`,
                      )
                    }
                  />
                  <span className="sr-only">{label.name}</span>
                  <span aria-hidden="true" className="mc-switch-track" />
                </label>
              </li>
            )
          })}
          {!data &&
            [0, 1, 2, 3].map((index) => (
              <li key={index} aria-hidden="true">
                <Skeleton width={240} />
              </li>
            ))}
        </ul>
        {!canEdit && (
          <p className="mc-panel-note mc-muted">
            Developers, admins and the owner can change rules.
          </p>
        )}
      </Panel>

      <Panel
        title="Flagged sessions"
        description={`Newest first, ${rangePhrase[range]}`}
        id="mc-bot-flagged"
        flush
      >
        {data?.flagged.length ? (
          <table className="mc-table mc-bots-table">
            <thead>
              <tr>
                <th scope="col">Visitor</th>
                <th scope="col">When</th>
                <th scope="col">Why</th>
                <th scope="col">From</th>
                <th scope="col">Activity</th>
                {canEdit && <th scope="col">Action</th>}
              </tr>
            </thead>
            <tbody>
              {data.flagged.map((row) => (
                <tr key={row.session_id}>
                  <td data-label="Visitor">
                    <PersonCell
                      person={{
                        id: row.person_id,
                        distinct_id: row.distinct_id,
                        user_id: row.user_id,
                        traits: row.traits,
                      }}
                      href={href({
                        name: 'person',
                        projectId: project.id,
                        personId: row.person_id,
                      })}
                    />
                  </td>
                  <td data-label="When">
                    <a
                      className="mc-link mc-num"
                      href={href({
                        name: 'session',
                        projectId: project.id,
                        sessionId: row.session_id,
                      })}
                    >
                      {time.dateTime(row.started_at)}
                    </a>
                    <span className="mc-sub">{formatDuration(row.duration_seconds)}</span>
                  </td>
                  <td data-label="Why">
                    <span className="mc-values">
                      {row.reasons.map((reason) => (
                        <Pill key={reason} tone="warning">
                          {botRuleLabels[reason].name}
                        </Pill>
                      ))}
                      {row.override === 'human' && <Pill tone="positive">Marked as a person</Pill>}
                      {row.override === 'bot' && <Pill tone="negative">Blocked</Pill>}
                    </span>
                    {!row.excluded && <span className="mc-sub">Counted in reports</span>}
                  </td>
                  <td data-label="From">
                    <span className="mc-truncate">{placeLabel(row)}</span>
                    <span className="mc-sub mc-truncate" title={row.user_agent ?? undefined}>
                      {row.platform === 'web'
                        ? [row.browser, row.os_name].filter(Boolean).join(' on ') ||
                          'Unknown browser'
                        : platformLabels[row.platform]}
                    </span>
                  </td>
                  <td data-label="Activity" className="mc-num">
                    {plural(row.events_count, 'event')}
                    <span className="mc-sub">{plural(row.screens_count, 'page')}</span>
                  </td>
                  {canEdit && (
                    <td data-label="Action">
                      <span className="mc-row-actions">
                        {row.override !== 'human' && (
                          <button
                            type="button"
                            className="mc-btn mc-btn-quiet"
                            disabled={busy === row.session_id}
                            onClick={() =>
                              void act(
                                row.session_id,
                                () => api.setOverride(project.id, 'human', row.person_id),
                                'Marked as a person: their sessions count in reports',
                              )
                            }
                          >
                            <ShieldCheck size={16} aria-hidden="true" /> Not a bot
                          </button>
                        )}
                        {row.override !== 'bot' && (
                          <button
                            type="button"
                            className="mc-btn mc-btn-quiet"
                            disabled={busy === row.session_id}
                            onClick={() =>
                              void act(
                                row.session_id,
                                () => api.setOverride(project.id, 'bot', row.person_id),
                                'Blocked: new events from this visitor are refused',
                              )
                            }
                          >
                            <ShieldOff size={16} aria-hidden="true" /> Block
                          </button>
                        )}
                        {row.ip_hash && (
                          <button
                            type="button"
                            className="mc-btn mc-btn-quiet"
                            disabled={busy === row.session_id}
                            onClick={() =>
                              void act(
                                row.session_id,
                                () =>
                                  api.setOverride(
                                    project.id,
                                    'bot',
                                    row.person_id,
                                    row.session_id,
                                    'Blocked from the bots page',
                                  ),
                                'Network blocked: anything from it is refused',
                              )
                            }
                          >
                            <Wifi size={16} aria-hidden="true" /> Block network
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>{data ? `No sessions looked automated ${rangePhrase[range]}.` : 'Loading.'}</Empty>
        )}
      </Panel>

      <Panel
        title="Blocks and exceptions"
        description="People and networks you marked by hand"
        id="mc-bot-overrides"
        flush
      >
        {data?.overrides.length ? (
          <table className="mc-table">
            <thead>
              <tr>
                <th scope="col">Who</th>
                <th scope="col">Decision</th>
                <th scope="col">By</th>
                {canEdit && <th scope="col">Action</th>}
              </tr>
            </thead>
            <tbody>
              {data.overrides.map((override) => (
                <tr key={override.id}>
                  <td data-label="Who">
                    {override.person_id ? (
                      <a
                        className="mc-link mc-mono"
                        href={href({
                          name: 'person',
                          projectId: project.id,
                          personId: override.person_id,
                        })}
                      >
                        {override.distinct_id}
                      </a>
                    ) : (
                      <span>
                        Network <span className="mc-mono">{override.ip_hash}…</span>
                      </span>
                    )}
                    {override.note && <span className="mc-sub">{override.note}</span>}
                  </td>
                  <td data-label="Decision">
                    {override.verdict === 'bot' ? (
                      <Pill tone="negative">Blocked</Pill>
                    ) : (
                      <Pill tone="positive">A person</Pill>
                    )}
                  </td>
                  <td data-label="By">
                    {override.created_by ?? 'Unknown'}
                    <span className="mc-sub">{time.dateTime(override.created_at)}</span>
                  </td>
                  {canEdit && (
                    <td data-label="Action">
                      <button
                        type="button"
                        className="mc-btn mc-btn-quiet"
                        disabled={busy === override.id}
                        onClick={() =>
                          void act(override.id, () => api.deleteOverride(override.id), 'Removed')
                        }
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>
            {data
              ? 'Nothing marked by hand. Block a visitor or mark one as a person from the list above or their profile.'
              : 'Loading.'}
          </Empty>
        )}
      </Panel>
    </div>
  )
}
