type BrandProps = {
  compact?: boolean
  context?: string
}

export function Brand({ compact = false, context }: BrandProps) {
  return (
    <span className={`brand-lockup ${compact ? 'brand-lockup-compact' : ''}`}>
      <img className="brand-logo-image" src="/favicon.svg" alt="" aria-hidden="true" />
      <span className="brand-wordmark">
        Kissmyapps<span>.dev</span>
      </span>
      {context && <span className="brand-context">{context}</span>}
    </span>
  )
}
