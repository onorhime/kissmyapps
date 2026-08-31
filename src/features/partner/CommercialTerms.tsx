import { useState } from 'react'
import { FileText, LockKeyhole } from 'lucide-react'
import { EmptyState } from '../../components/States'
import { money } from './data'
import { agreementVersions, documentDate } from './profileData'

export function CommercialTerms({
  empty,
  onDocuments,
}: {
  empty: boolean
  onDocuments: () => void
}) {
  const [version, setVersion] = useState('v1')
  const selected = agreementVersions.find((item) => item.id === version) ?? agreementVersions[0]
  const agreement = selected.agreement
  return (
    <section className="panel commercial-panel">
      <div className="panel-heading">
        <div>
          <h2>Commercial terms</h2>
          <p>Read-only agreement context and effective versions.</p>
        </div>
        <LockKeyhole size={18} className="muted-icon" />
      </div>
      {empty ? (
        <EmptyState
          icon={<FileText size={28} />}
          title="No commercial agreement yet"
          description="Terms will appear after your first partnership is configured. No model, rate, attribution window, or payment minimum has been assigned."
        />
      ) : (
        <div className="commercial-content">
          <div className="commercial-current-note">
            <strong>Current sample: {agreementVersions[0].label}</strong>
            <p>
              The same 30% Revenue share, USD, and $100 minimum shown in Payouts. These are example
              terms, not a live agreement.
            </p>
          </div>
          <label className="form-field commercial-version-picker">
            Agreement version
            <select value={version} onChange={(event) => setVersion(event.target.value)}>
              {agreementVersions.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.label} · {item.current ? 'Current sample' : 'Draft example'}
                </option>
              ))}
            </select>
          </label>
          <div className="commercial-version-heading" aria-live="polite">
            <h3>{selected.label}</h3>
            <span className={`status-badge ${selected.current ? 'badge-green' : 'badge-neutral'}`}>
              {selected.status} · Sample
            </span>
          </div>
          {!selected.current && (
            <p className="inline-note">
              Draft example only. No effective date or approval; reviewing it does not change
              current terms, reports, or paid statements.
            </p>
          )}
          <dl className="commercial-facts">
            {[
              ['Model', agreement.model],
              ['Example rate', `${agreement.rateBps / 100}% of eligible net revenue`],
              ['Effective from', documentDate(selected.effective, 'Not set · draft')],
              ['Expiration', documentDate(selected.expires, 'No expiration set in this example')],
              ['Created', documentDate(selected.created)],
              ['Attribution window', '30 days · illustrative, not a live policy'],
              ['Payout frequency', agreement.frequency],
              ['Payout currency', agreement.currency],
              [
                'Minimum payout',
                `${money(agreement.minimumMinor)} USD · Below minimum carries forward`,
              ],
              ['Payment method', `${agreement.method} · ${agreement.destination}`],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <section className="commercial-rules">
            <h3>Example eligibility rules</h3>
            <ul>
              <li>
                Verified first payments and eligible renewals contribute to the agreement-defined
                net revenue basis; trials alone do not earn revenue share.
              </li>
              <li>
                Fees, actual refund balance impact, disputes, settlement FX, taxes, and contractual
                deductions are considered before commission.
              </li>
              <li>
                Paid statements retain their effective agreement snapshot. Later corrections are
                recorded in a new period.
              </li>
              <li>
                A commercial change requires a newly approved, signed, effective agreement version;
                partners cannot edit rates here.
              </li>
            </ul>
            <p>
              All rules and the attribution window above are illustrative. The real agreement and
              backend determine eligibility; this page performs no commercial calculations.
            </p>
          </section>
          <button className="button button-white" onClick={onDocuments}>
            <FileText size={15} />
            Review partnership documents
          </button>
        </div>
      )}
    </section>
  )
}
