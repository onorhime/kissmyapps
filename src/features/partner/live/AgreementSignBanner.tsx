import { useEffect, useRef, useState } from 'react'
import { Check, Download, FileSignature, LoaderCircle } from 'lucide-react'
import { Dialog } from '../../../components/Dialog'
import type { PartnerDataError, PartnerDataGateway, PartnerSignatureRequest } from '../api'

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100)
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`
  }
}

function modelLabel(model: string): string {
  const labels: Record<string, string> = {
    cpl: 'CPL',
    cpa: 'CPA · fixed per acquisition',
    revenue_share: 'Revenue share',
    hybrid: 'Hybrid',
  }
  return labels[model] ?? model
}

type SignPhase = 'review' | 'signing' | 'error'

export function AgreementSignBanner({ gateway }: { gateway: PartnerDataGateway }) {
  const [queue, setQueue] = useState<readonly PartnerSignatureRequest[] | null>(null)
  const [loadError, setLoadError] = useState<PartnerDataError | null>(null)
  const [active, setActive] = useState<PartnerSignatureRequest | null>(null)
  const [phase, setPhase] = useState<SignPhase>('review')
  const [actionError, setActionError] = useState<string | null>(null)
  const [legalName, setLegalName] = useState('')
  const [signedName, setSignedName] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [reloadVersion, setReloadVersion] = useState(0)
  const loadedRef = useRef(false)
  const signing = phase === 'signing'
  const signatureQueue =
    typeof gateway.getSignatureQueue === 'function' && typeof gateway.signAgreement === 'function'
      ? gateway
      : null

  useEffect(() => {
    if (!signatureQueue?.getSignatureQueue) return
    let active = true
    void signatureQueue
      .getSignatureQueue()
      .then((result) => {
        if (!active) return
        if (result.status === 'ready' || result.status === 'empty') {
          loadedRef.current = true
          setQueue(result.data)
          setLoadError(null)
        } else if (!loadedRef.current) {
          setLoadError(result.error)
        }
      })
      .catch(() => {
        if (active && !loadedRef.current) {
          setLoadError({
            code: 'temporarily_unavailable',
            message: 'Agreement signature requests are temporarily unavailable.',
            retryable: true,
          })
        }
      })
    return () => {
      active = false
    }
  }, [reloadVersion, signatureQueue])

  useEffect(() => {
    if (!signedName) return
    const timeout = setTimeout(() => setSignedName(null), 8000)
    return () => clearTimeout(timeout)
  }, [signedName])

  async function openReview(request: PartnerSignatureRequest) {
    setActive(request)
    setPhase('review')
    setActionError(null)
    setLegalName('')
    setDownloadUrl(null)
    if (gateway.getAgreementDocumentUrl) {
      const url = await gateway.getAgreementDocumentUrl({ filePath: request.filePath })
      if (url.status === 'ready' && url.data) setDownloadUrl(url.data)
    }
  }

  async function confirmSign() {
    if (!active || !gateway.signAgreement) return
    if (legalName.trim().length < 2) {
      setActionError('Enter your full legal name to sign.')
      return
    }
    setPhase('signing')
    setActionError(null)
    const result = await gateway.signAgreement({
      documentId: active.documentId,
      legalName: legalName.trim(),
    })
    if (result.status === 'ready') {
      setSignedName(legalName.trim())
      setActive(null)
      setQueue((current) =>
        current ? current.filter((item) => item.documentId !== active.documentId) : current,
      )
      setPhase('review')
      return
    }
    setPhase('error')
    setActionError(result.error?.message ?? 'The signature could not be recorded. Try again.')
  }

  if (!signatureQueue) return null

  if (loadError && queue === null) {
    return (
      <section className="agreement-sign-note" role="note">
        <FileSignature size={17} aria-hidden="true" />
        <p>Agreement signature requests could not be loaded. Refresh to try again.</p>
        <button
          className="agreement-sign-retry"
          type="button"
          onClick={() => setReloadVersion((version) => version + 1)}
        >
          Retry
        </button>
      </section>
    )
  }

  const successNote = signedName ? (
    <div className="agreement-sign-success" role="status">
      <Check size={16} aria-hidden="true" /> Signed as {signedName}. KissMyApps will countersign
      next.
    </div>
  ) : null

  if (!queue?.length) return successNote

  return (
    <>
      <section className="agreement-sign-banner" aria-labelledby="agreement-sign-title">
        <span className="agreement-sign-icon" aria-hidden="true">
          <FileSignature size={19} />
        </span>
        <div>
          <h2 id="agreement-sign-title">Action required · partnership agreement</h2>
          <p>
            {queue.length === 1
              ? `Review and sign the agreement for ${queue[0].productName} (version ${queue[0].version}) to unlock commercial access.`
              : `${queue.length} partnership agreements are waiting for your signature.`}
          </p>
        </div>
        <button
          className="agreement-sign-button"
          type="button"
          onClick={() => void openReview(queue[0])}
        >
          {queue.length === 1 ? 'Review & sign' : 'Review agreements'}
        </button>
      </section>

      <Dialog
        open={Boolean(active)}
        onOpenChange={(open) => {
          if (!open) setActive(null)
        }}
        title="Review and sign the partnership agreement"
        description="Read the terms, then sign with your full legal name."
      >
        {active && (
          <div className="agreement-sign-dialog">
            <dl className="agreement-sign-terms">
              <div>
                <dt>Product</dt>
                <dd>{active.productName}</dd>
              </div>
              <div>
                <dt>Commission model</dt>
                <dd>{modelLabel(active.model)}</dd>
              </div>
              <div>
                <dt>Attribution window</dt>
                <dd>{active.attributionWindowDays} days</dd>
              </div>
              <div>
                <dt>Payout cadence</dt>
                <dd>{active.payoutFrequencyDays} days</dd>
              </div>
              <div>
                <dt>Minimum payout</dt>
                <dd>{money(active.minimumPayoutMinor, active.payoutCurrency)}</dd>
              </div>
            </dl>
            {downloadUrl ? (
              <a
                className="agreement-sign-download"
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Download size={16} aria-hidden="true" /> Open the agreement PDF
              </a>
            ) : (
              <p className="agreement-sign-download-pending" role="status">
                Preparing the document preview…
              </p>
            )}
            <label className="form-field" htmlFor="agreement-sign-legal-name">
              <span>Your full legal name</span>
              <input
                id="agreement-sign-legal-name"
                value={legalName}
                onChange={(event) => setLegalName(event.target.value)}
                maxLength={160}
                autoComplete="name"
                aria-invalid={Boolean(actionError)}
              />
            </label>
            <p className="field-hint">
              Signing records your legal name, account, and the exact document version as immutable
              evidence.
            </p>
            {actionError && (
              <p className="agreement-sign-error" role="alert">
                {actionError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                type="button"
                disabled={signing}
                onClick={() => setActive(null)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="button"
                disabled={signing}
                onClick={() => void confirmSign()}
              >
                {signing && <LoaderCircle className="spin" size={16} aria-hidden="true" />}
                {signing ? 'Signing…' : 'Sign the agreement'}
              </button>
            </div>
          </div>
        )}
      </Dialog>

      {successNote}
    </>
  )
}
