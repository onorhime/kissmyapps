import { ArrowLeft, ChartNoAxesColumn, ClipboardCheck } from 'lucide-react'
import './ProductStats.css'

export type ProgramProductNoticeProps = Readonly<{
  programName: string
  onBack: () => void
  /** Opens program review. Left out for a role that cannot review programs. */
  onOpenPrograms?: () => void
  onOpenStats?: () => void
}>

/**
 * What the setup address of a program's product shows instead of the setup steps: the
 * merchant set the program up, so there is nothing to set up here.
 */
export function ProgramProductNotice({
  programName,
  onBack,
  onOpenPrograms,
  onOpenStats,
}: ProgramProductNoticeProps) {
  return (
    <section className="admin-page" aria-labelledby="admin-program-product-title">
      <button className="admin-back-button" type="button" onClick={onBack}>
        <ArrowLeft size={17} aria-hidden="true" /> Back to Products
      </button>
      <div className="admin-state-card">
        <span className="admin-state-icon">
          <ClipboardCheck size={30} aria-hidden="true" />
        </span>
        <h1 id="admin-program-product-title">{programName} is a program</h1>
        <p>
          Its merchant set it up in their own console, so there are no setup steps here.{' '}
          {onOpenPrograms
            ? 'Review or pause it in Programs.'
            : 'An Owner or Operations admin reviews it in Programs.'}
        </p>
        {(onOpenPrograms || onOpenStats) && (
          <div className="admin-state-actions admin-program-product-actions">
            {onOpenPrograms && (
              <button className="admin-primary-button" type="button" onClick={onOpenPrograms}>
                <ClipboardCheck size={17} aria-hidden="true" /> Open Programs
              </button>
            )}
            {onOpenStats && (
              <button className="admin-secondary-button" type="button" onClick={onOpenStats}>
                <ChartNoAxesColumn size={17} aria-hidden="true" /> View stats
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
