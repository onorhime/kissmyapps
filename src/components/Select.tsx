import { ChevronDown } from 'lucide-react'
import './Select.css'

export type SelectOption = Readonly<{ value: string; label: string }>

type SelectProps = {
  options: readonly SelectOption[]
  value: string
  onChange: (value: string) => void
  /** Visible field label rendered by the component. Omit when an external label wraps the control. */
  label?: string
  /** Render the label in the accessible sr-only style (e.g. compact filter bars). */
  srOnlyLabel?: boolean
  /** Accessible name when the control renders without a visible label of its own. */
  ariaLabel?: string
  id?: string
  disabled?: boolean
  invalid?: boolean
  required?: boolean
  describedBy?: string
  className?: string
}

/**
 * A native <select> dressed as the shared dark dropdown control. The native
 * element keeps platform keyboard, mobile, and assistive behavior; only the
 * chrome is custom. Colors inherit from the surrounding CSS scope through the
 * --kma-select-* variables so the same component works on any surface.
 */
export function Select({
  options,
  value,
  onChange,
  label,
  srOnlyLabel = false,
  ariaLabel,
  id,
  disabled = false,
  invalid = false,
  required = false,
  describedBy,
  className,
}: SelectProps) {
  const control = (
    <>
      <select
        className="kma-select-control"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        required={required}
        id={id}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value || 'option-empty'}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="kma-select-chevron" size={16} aria-hidden="true" />
    </>
  )

  if (label === undefined) {
    return <span className={className ? `kma-select ${className}` : 'kma-select'}>{control}</span>
  }

  return (
    <label className={className ? `kma-select-field ${className}` : 'kma-select-field'}>
      <span className={srOnlyLabel ? 'kma-select-label sr-only' : 'kma-select-label'}>{label}</span>
      <span className={invalid ? 'kma-select kma-select-invalid' : 'kma-select'}>{control}</span>
    </label>
  )
}
