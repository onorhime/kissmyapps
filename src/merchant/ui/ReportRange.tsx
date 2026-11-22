import { useState, type ReactNode } from 'react'
import type { CustomRange, Range } from '../api'
import { isCustomRange } from '../ranges'
import { Segmented } from './Primitives'

export function ReportRange<T extends Range>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: ReactNode }>
  onChange: (range: NoInfer<T> | CustomRange) => void
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const chosen: CustomRange = `${from}..${to}`
  return (
    <div className="mc-range-picker">
      <Segmented
        label={label}
        options={options}
        value={value}
        onChange={(v) => {
          setOpen(false)
          onChange(v)
        }}
      />
      <button
        className="mc-btn mc-btn-secondary"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {isCustomRange(value) ? value.split('..').join(' – ') : 'Custom dates'}
      </button>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (isCustomRange(chosen)) {
              onChange(chosen)
              setOpen(false)
            }
          }}
        >
          <label>
            From{' '}
            <input
              type="date"
              required
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Through{' '}
            <input
              type="date"
              required
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          {from && to && !isCustomRange(chosen) && (
            <span role="status">Choose up to 366 consecutive days.</span>
          )}
          <button type="submit" className="mc-btn mc-btn-primary" disabled={!isCustomRange(chosen)}>
            Apply dates
          </button>
        </form>
      )}
    </div>
  )
}
