import { useMemo, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import type { Point } from '../data/model'
import { formatCompact, formatCount, formatTime } from '../format'
import { niceTicks, seriesColors, useWidth } from './chart-utils'

export type ChartSeries = { key: string; label: string; color: string; points: Point[] }

type LineChartProps = {
  series: ChartSeries[]
  height?: number
  label: string
  formatX: (time: number) => string
  formatTooltip?: (time: number) => string
  formatValue?: (value: number) => string
  annotations?: Array<{ time: number; label: string }>
  area?: boolean
  integers?: boolean
  /** Shown over the plot while every value is zero. */
  empty?: string
}

export function LineChart({
  series,
  height = 220,
  label,
  formatX,
  formatTooltip = formatX,
  formatValue = formatCount,
  annotations = [],
  area = series.length === 1,
  integers = true,
  empty,
}: LineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)
  const count = series[0]?.points.length ?? 0
  const max = Math.max(0, ...series.flatMap((line) => line.points.map((point) => point.value)))
  const ticks = useMemo(() => {
    const raw = niceTicks(max)
    return integers ? raw.filter((tick, index) => index === 0 || Number.isInteger(tick)) : raw
  }, [max, integers])
  const top = ticks[ticks.length - 1] || 1
  const visibleNotes = annotations.filter((note) =>
    series[0]?.points.some((point) => point.time === note.time),
  )
  const pad = {
    left: Math.max(...ticks.map((tick) => formatCompact(tick).length)) * 7 + 14,
    right: 12,
    top: visibleNotes.length ? 30 : 10,
    bottom: 26,
  }
  const plotWidth = Math.max(10, width - pad.left - pad.right)
  const plotHeight = Math.max(10, height - pad.top - pad.bottom)
  const x = (index: number) =>
    pad.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth)
  const y = (value: number) => pad.top + plotHeight - (value / top) * plotHeight

  const labelEvery = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotWidth / 92))))
  const labelIndexes: number[] = []
  for (let index = count - 1; index >= 0; index -= labelEvery) labelIndexes.push(index)

  const pick = (clientX: number, element: Element) => {
    const box = element.getBoundingClientRect()
    const relative = clientX - box.left - pad.left
    const index = count <= 1 ? 0 : Math.round((relative / plotWidth) * (count - 1))
    setActive(Math.min(count - 1, Math.max(0, index)))
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setActive((current) => {
      const start = current ?? count - 1
      return Math.min(count - 1, Math.max(0, start + (event.key === 'ArrowRight' ? 1 : -1)))
    })
  }
  const activePoint = active !== null ? series[0]?.points[active] : undefined

  return (
    <div
      ref={ref}
      className="mc-chart"
      style={{ height }}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Use the left and right arrow keys to read each value.`}
      onKeyDown={onKey}
      onFocus={() => setActive((current) => current ?? count - 1)}
      onBlur={() => setActive(null)}
    >
      <svg width={width} height={height} aria-hidden="true">
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? 'mc-chart-base' : 'mc-chart-grid'}
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text
              className="mc-chart-tick"
              x={pad.left - 10}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
            >
              {formatCompact(tick)}
            </text>
          </g>
        ))}
        {labelIndexes.map((index) => {
          const position = x(index)
          const anchor =
            position - pad.left < 30
              ? 'start'
              : width - pad.right - position < 30
                ? 'end'
                : 'middle'
          return (
            <text
              key={index}
              className="mc-chart-tick"
              x={position}
              y={height - 6}
              textAnchor={anchor}
            >
              {formatX(series[0].points[index].time)}
            </text>
          )
        })}
        {visibleNotes.map((note) => {
          const index = series[0].points.findIndex((point) => point.time === note.time)
          const position = x(index)
          const anchor = width - pad.right - position < 120 ? 'end' : 'start'
          return (
            <g key={note.time} className="mc-chart-note">
              <line x1={position} x2={position} y1={pad.top - 6} y2={pad.top + plotHeight} />
              <text
                x={anchor === 'start' ? position + 6 : position - 6}
                y={pad.top - 12}
                textAnchor={anchor}
              >
                {note.label}
              </text>
            </g>
          )
        })}
        {series.map((line) => {
          const points = line.points
          const settled = points.filter((point) => !point.partial)
          const path = (subset: Point[], offset: number) =>
            subset
              .map(
                (point, index) =>
                  `${index ? 'L' : 'M'}${x(index + offset).toFixed(1)},${y(point.value).toFixed(1)}`,
              )
              .join(' ')
          const solid = path(settled, 0)
          const last = points.length - 1
          const partial = points[last]?.partial && last > 0
          return (
            <g key={line.key}>
              {area && settled.length > 1 && (
                <path
                  d={`${solid} L${x(settled.length - 1)},${y(0)} L${x(0)},${y(0)} Z`}
                  fill={line.color}
                  opacity={0.1}
                />
              )}
              <path
                d={solid}
                fill="none"
                stroke={line.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {partial && (
                <path
                  d={`M${x(last - 1)},${y(points[last - 1].value)} L${x(last)},${y(points[last].value)}`}
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  strokeLinecap="round"
                />
              )}
              {count === 1 && <circle cx={x(0)} cy={y(points[0].value)} r={4} fill={line.color} />}
            </g>
          )
        })}
        {active !== null && activePoint && (
          <g>
            <line
              className="mc-chart-cross"
              x1={x(active)}
              x2={x(active)}
              y1={pad.top}
              y2={pad.top + plotHeight}
            />
            {series.map((line) => (
              <circle
                key={line.key}
                cx={x(active)}
                cy={y(line.points[active].value)}
                r={4.5}
                fill={line.color}
                className="mc-chart-dot"
              />
            ))}
          </g>
        )}
        <rect
          x={pad.left}
          y={pad.top}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          onPointerMove={(event: PointerEvent<SVGRectElement>) =>
            pick(event.clientX, event.currentTarget.ownerSVGElement ?? event.currentTarget)
          }
          onPointerLeave={() => setActive(null)}
        />
      </svg>
      {empty && max === 0 && (
        <p
          className="mc-chart-empty"
          style={{ left: pad.left, right: pad.right, top: pad.top, height: plotHeight }}
        >
          {empty}
        </p>
      )}
      {active !== null && activePoint && (
        <div
          className="mc-tooltip"
          role="status"
          style={{
            left: Math.min(Math.max(x(active), 90), width - 90),
            top: pad.top,
          }}
        >
          <span className="mc-tooltip-title">
            {formatTooltip(activePoint.time)}
            {activePoint.partial ? ' (so far)' : ''}
          </span>
          {series.map((line) => (
            <span key={line.key} className="mc-tooltip-row">
              <i style={{ background: line.color }} aria-hidden="true" />
              <strong>{formatValue(line.points[active].value)}</strong>
              {series.length > 1 && <span>{line.label}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function MinuteStrip({
  points,
  color = seriesColors[0],
  label,
}: {
  points: Point[]
  color?: string
  label: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>(240)
  const height = 30
  const gap = 1
  const barWidth = Math.max(1, (width - gap * (points.length - 1)) / points.length)
  const max = Math.max(1, ...points.map((point) => point.value))
  return (
    <div ref={ref} className="mc-strip" role="img" aria-label={label}>
      <svg width={width} height={height} aria-hidden="true">
        <line className="mc-chart-base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
        {points.map((point, index) =>
          point.value > 0 ? (
            <rect
              key={point.time}
              x={index * (barWidth + gap)}
              y={height - 1 - Math.max(2, (point.value / max) * (height - 2))}
              width={barWidth}
              height={Math.max(2, (point.value / max) * (height - 2))}
              fill={color}
              opacity={point.partial ? 0.55 : 1}
            >
              <title>{`${formatTime(point.time)} · ${formatCount(point.value)} events`}</title>
            </rect>
          ) : null,
        )}
      </svg>
    </div>
  )
}

export type BarRow = {
  key: string
  label: ReactNode
  value: number
  display: string
  href?: string
}

/** A ranked list: each row's thin bar is its share of the largest row; the leader in ink. */
export function BarList({ rows }: { rows: BarRow[] }) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <ol className="mc-barlist">
      {rows.map((row) => {
        const body = (
          <>
            <span className="mc-barlist-line">
              <span className="mc-barlist-label">{row.label}</span>
              <span className="mc-num">{row.display}</span>
            </span>
            <span className="mc-barlist-track" aria-hidden="true">
              <span className="mc-barlist-bar" style={{ width: `${(row.value / max) * 100}%` }} />
            </span>
          </>
        )
        return <li key={row.key}>{row.href ? <a href={row.href}>{body}</a> : <div>{body}</div>}</li>
      })}
    </ol>
  )
}
