import { useRef, useState } from 'react'
import {
  CreditCard,
  FileText,
  Fingerprint,
  Landmark,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
  Wallet,
} from 'lucide-react'
import { Dialog } from '../../components/Dialog'
import { ErrorState, LoadingState } from '../../components/States'
import { ProfileDetails } from './ProfileDetails'
import { CommercialTerms } from './CommercialTerms'
import { PartnerDocuments } from './PartnerDocuments'
import type { PreviewProfile, PreviewState, ProfileSection } from './data'

export function Profile(props: Parameters<typeof ProfileWorkspace>[0]) {
  return <ProfileWorkspace key={props.state === 'partial' ? 'sample' : props.state} {...props} />
}

function ProfileWorkspace({
  state,
  profile,
  onSave,
  notify,
  onRetry,
  section,
  onSectionChange: setSection,
}: {
  state: PreviewState
  profile: PreviewProfile
  onSave: (profile: PreviewProfile) => void
  notify: (message: string) => void
  onRetry: () => void
  section: ProfileSection
  onSectionChange: (section: ProfileSection) => void
}) {
  const [draft, setDraft] = useState(profile)
  const [method, setMethod] = useState('bank')
  const [securityOpen, setSecurityOpen] = useState(false)
  const documentsTab = useRef<HTMLButtonElement>(null)
  const [previousSection, setPreviousSection] = useState(section)
  // Retain unsaved profile fields across sections, but close transient verification.
  if (previousSection !== section) {
    setPreviousSection(section)
    setSecurityOpen(false)
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">THE DETAILS BEHIND THE PARTNERSHIP</p>
          <h1>
            Profile &amp; Documents<span className="heading-dot">.</span>
          </h1>
          <p>Keep your partnership details, preferences, and paperwork together.</p>
        </div>
      </div>
      {state === 'loading' ? (
        <LoadingState label="Loading profile preview" />
      ) : state === 'error' ? (
        <ErrorState onRetry={onRetry} />
      ) : (
        <>
          <div className="profile-identity-card">
            <div className="profile-avatar">
              <UserRound size={29} />
            </div>
            <div>
              <h2>{profile.publicName}</h2>
              <p>
                <Mail size={12} />
                partner@example.invalid
              </p>
            </div>
            <span className="status-badge badge-neutral">Preview account</span>
            <div className="profile-identity-note">
              <ShieldCheck size={16} />
              <span>
                Your information stays
                <br />
                inside this UI preview.
              </span>
            </div>
          </div>
          <div
            className="profile-section-nav"
            aria-label="Profile sections"
            onFocusCapture={(event) => {
              if (!(event.target instanceof HTMLButtonElement)) return
              const nav = event.currentTarget
              const viewport = nav.getBoundingClientRect()
              const control = event.target.getBoundingClientRect()
              if (viewport.width <= 0) return
              // Native Tab scrolling can leave a partly visible tab clipped.
              // Reveal its full focus ring without scrolling the page vertically.
              if (control.left < viewport.left + 8)
                nav.scrollLeft += control.left - viewport.left - 8
              else if (control.right > viewport.right - 8)
                nav.scrollLeft += control.right - viewport.right + 8
            }}
          >
            {(
              [
                ['details', 'Partner details', UserRound],
                ['payment', 'Payout preferences', CreditCard],
                ['terms', 'Commercial terms', FileText],
                ['documents', 'Documents', FileText],
                ['security', 'Security', ShieldCheck],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                ref={value === 'documents' ? documentsTab : undefined}
                className={section === value ? 'selected' : ''}
                aria-pressed={section === value}
                onClick={() => setSection(value)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>

          {section === 'details' && (
            <ProfileDetails
              profile={profile}
              draft={draft}
              onDraftChange={setDraft}
              onSave={onSave}
              notify={notify}
            />
          )}
          {section === 'terms' && (
            <CommercialTerms
              empty={state === 'empty'}
              onDocuments={() => {
                setSection('documents')
                // The CTA unmounts; keep focus on the persistent destination control.
                documentsTab.current?.focus()
              }}
            />
          )}

          {section === 'payment' && (
            <div className="profile-grid">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Payout preferences</h2>
                    <p>Explore the payment settings layout without entering real details.</p>
                  </div>
                  <LockKeyhole size={18} className="muted-icon" />
                </div>
                <div className="payment-settings-content">
                  <div
                    className="payment-method-options"
                    role="group"
                    aria-label="Preview payout method"
                  >
                    <button
                      className={method === 'bank' ? 'selected' : ''}
                      aria-pressed={method === 'bank'}
                      onClick={() => setMethod('bank')}
                    >
                      <Landmark size={21} />
                      <strong>Bank transfer</strong>
                      <span>To your verified bank account</span>
                    </button>
                    <button
                      className={method === 'crypto' ? 'selected' : ''}
                      aria-pressed={method === 'crypto'}
                      onClick={() => setMethod('crypto')}
                    >
                      <Wallet size={21} />
                      <strong>Crypto</strong>
                      <span>To a verified wallet &amp; network</span>
                    </button>
                  </div>
                  <div className="form-grid">
                    {method === 'bank' ? (
                      <>
                        <label className="form-field">
                          Account holder
                          <input
                            value={state === 'empty' ? 'Not configured' : 'Example partner'}
                            readOnly
                          />
                        </label>
                        <label className="form-field">
                          Bank name
                          <input
                            value={state === 'empty' ? 'Not configured' : 'Example bank'}
                            readOnly
                          />
                        </label>
                        <label className="form-field full-width">
                          Account number
                          <input
                            value={state === 'empty' ? '—' : '•••• •••• 4821 (sample)'}
                            readOnly
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label className="form-field">
                          Wallet
                          <input value="Not configured" readOnly />
                        </label>
                        <label className="form-field">
                          Network
                          <input value="Selected during verification" readOnly />
                        </label>
                      </>
                    )}
                    <label className="form-field full-width">
                      Payout currency
                      <input
                        value={
                          state === 'empty'
                            ? 'Defined by your future agreement'
                            : 'USD · Example agreement'
                        }
                        readOnly
                      />
                    </label>
                  </div>
                  <p className="inline-note">
                    Payment details are read-only in this preview. Do not enter real bank or wallet
                    information.
                  </p>
                  <button className="button button-white" onClick={() => setSecurityOpen(true)}>
                    <LockKeyhole size={15} />
                    Preview verification steps
                  </button>
                </div>
              </section>
              <aside className="profile-aside">
                <div className="panel profile-aside-card">
                  <ShieldCheck size={25} className="muted-icon" />
                  <h3>Protected by design.</h3>
                  <p>
                    Payment destination changes require your password, two-factor authentication,
                    email confirmation, and a 48-hour hold. Scheduled payouts lock their payment
                    details.
                  </p>
                  <p>A first crypto payout also requires a test transfer.</p>
                  <span className="status-badge badge-neutral">
                    Live verification not connected
                  </span>
                </div>
              </aside>
            </div>
          )}

          {section === 'documents' && <PartnerDocuments empty={state === 'empty'} />}

          {section === 'security' && (
            <div className="security-cards">
              <section className="panel security-card">
                <span className="outlined-icon">
                  <Fingerprint size={25} />
                </span>
                <div>
                  <h2>Two-factor authentication</h2>
                  <p>An extra layer of protection for your partner account and payout changes.</p>
                </div>
                <span className="status-badge badge-neutral">Not connected</span>
                <button className="button button-white" disabled>
                  Available after connection
                </button>
              </section>
              <section className="panel security-card">
                <span className="outlined-icon">
                  <LockKeyhole size={25} />
                </span>
                <div>
                  <h2>Password &amp; account recovery</h2>
                  <p>
                    Sign-in, password resets, and recovery will be managed by real Supabase Auth.
                  </p>
                </div>
                <span className="status-badge badge-neutral">Not connected</span>
                <button className="button button-white" disabled>
                  No authenticated session
                </button>
              </section>
              <p className="inline-note">
                This UI preview is not an authentication system. It does not collect passwords,
                create sessions, or change security settings.
              </p>
            </div>
          )}
        </>
      )}
      <Dialog
        open={securityOpen}
        onOpenChange={setSecurityOpen}
        title="A safer way to change payout details"
        description="This is a preview of the required security flow. No verification is performed."
      >
        <div className="guide-steps">
          <div>
            <span>01</span>
            <h3>Verify it’s really you</h3>
            <p>Reauthenticate with your password and two-factor verification.</p>
          </div>
          <div>
            <span>02</span>
            <h3>Confirm the new destination</h3>
            <p>A confirmation email is required before new payment details can be accepted.</p>
          </div>
          <div>
            <span>03</span>
            <h3>Allow the security hold</h3>
            <p>Changes take effect after a 48-hour hold. Scheduled payout details remain locked.</p>
          </div>
        </div>
        <p className="inline-note">
          The actual form stays disabled until these server-side safeguards are implemented.
        </p>
      </Dialog>
    </>
  )
}
