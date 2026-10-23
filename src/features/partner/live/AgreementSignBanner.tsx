import { PartnerRuleTerms } from './PartnerRuleTerms'
import { providerMoney } from '../../../lib/providerMoney'
import { useEffect, useRef, useState } from 'react'
import { Download, FileSignature, LoaderCircle } from 'lucide-react'
import { Dialog } from '../../../components/Dialog'
import { StatusNotice } from '../../../components/ActionNotice'
import type { PartnerDataError, PartnerDataGateway, PartnerSignatureRequest } from '../api'

const money = providerMoney

function modelLabel(model: string): string {
  const labels: Record<string, string> = {
    cpl: 'CPL',
    cpa: 'CPA · fixed per acquisition',
    revenue_share: 'Revenue share',
    hybrid: 'Hybrid',
  }
  return labels[model] ?? model
}

type SignPhase = 'review' | 'signing' | 'checking' | 'error' | 'uncertain'

export function AgreementSignBanner({
  gateway,
  onCompleted,
}: {
  gateway: PartnerDataGateway
  onCompleted?: () => void
}) {
  const [queue, setQueue] = useState<readonly PartnerSignatureRequest[] | null>(null)
  const [loadError, setLoadError] = useState<PartnerDataError | null>(null)
  const [active, setActive] = useState<PartnerSignatureRequest | null>(null)
  const [phase, setPhase] = useState<SignPhase>('review')
  const [actionError, setActionError] = useState<string | null>(null)
  const [legalName, setLegalName] = useState('')
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [documentError, setDocumentError] = useState<string | null>(null)
  const [documentReadyUntil, setDocumentReadyUntil] = useState(0)
  const [documentReload, setDocumentReload] = useState(0)
  const [acknowledged, setAcknowledged] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)
  const loadedRef = useRef(false)
  const submittingRef = useRef(false)
  const signing = phase === 'signing' || phase === 'checking'
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
    if (!confirmation) return
    const timeout = setTimeout(() => setConfirmation(null), 8000)
    return () => clearTimeout(timeout)
  }, [confirmation])

  useEffect(() => {
    if (!active) return
    let current = true
    let expiry: ReturnType<typeof setTimeout> | undefined
    const loadingTimeout = setTimeout(() => {
      if (!current) return
      current = false
      setDocumentError('The agreement PDF request timed out. Reload it before signing.')
    }, 15_000)
    void (async () => {
      try {
        const result = await gateway.getAgreementDocumentUrl?.({ filePath: active.filePath })
        if (!current) return
        if (result?.status !== 'ready' || !result.data) throw new Error('document unavailable')
        setDownloadUrl(result.data)
        setDocumentReadyUntil(Date.now() + 240_000)
        expiry = setTimeout(() => {
          if (!current) return
          setDownloadUrl(null)
          setDocumentReadyUntil(0)
          setAcknowledged(false)
          setDocumentError('This document link has expired. Reload it before signing.')
        }, 240_000)
      } catch {
        if (current)
          setDocumentError('The agreement PDF could not be opened. Reload it before signing.')
      } finally {
        clearTimeout(loadingTimeout)
      }
    })()
    return () => {
      current = false
      clearTimeout(loadingTimeout)
      if (expiry) clearTimeout(expiry)
    }
  }, [active, documentReload, gateway])

  function openReview(request: PartnerSignatureRequest) {
    setActive(request)
    setPhase('review')
    setActionError(null)
    setLegalName('')
    setDownloadUrl(null)
    setDocumentReadyUntil(0)
    setDocumentError(null)
    setAcknowledged(false)
  }

  function reloadDocument() {
    setDownloadUrl(null)
    setDocumentReadyUntil(0)
    setDocumentError(null)
    setAcknowledged(false)
    setDocumentReload((value) => value + 1)
  }

  function finishReview(request: PartnerSignatureRequest, message: string) {
    setConfirmation(message)
    setActive(null)
    setQueue((current) =>
      current ? current.filter((item) => item.documentId !== request.documentId) : current,
    )
    setPhase('review')
    setActionError(null)
    onCompleted?.()
  }

  async function reconcileSignature(request: PartnerSignatureRequest, failureMessage: string) {
    // An error or lost response is not proof that the write failed. Read the
    // partner-safe directory before offering another legal-signature attempt.
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        gateway.getDocuments(request.productId),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), 15_000)
        }),
      ])
      if (result?.status === 'ready' || result?.status === 'empty') {
        const document = result.data.find((item) => item.id === request.documentId)
        if (document?.version === request.version) {
          const hasPartnerSignature =
            document.partnerSignedAt && Number.isFinite(Date.parse(document.partnerSignedAt))
          if (hasPartnerSignature && document.status === 'awaiting_kissmyapps_signature') {
            finishReview(
              request,
              'The partner signature is recorded. KissMyApps will countersign next.',
            )
            return
          }
          if (
            hasPartnerSignature &&
            document.companySignedAt &&
            Number.isFinite(Date.parse(document.companySignedAt)) &&
            ['signed', 'active'].includes(document.status)
          ) {
            finishReview(request, 'This agreement has already been signed by both parties.')
            return
          }
          if (!document.partnerSignedAt && document.status === 'awaiting_partner_signature') {
            setPhase('error')
            setActionError(failureMessage)
            return
          }
        }
      }
    } catch {
      // Keep this unresolved instead of treating a missing read as a failed write.
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    setPhase('uncertain')
    setActionError(
      'We couldn’t confirm the signature status. Check status before trying to sign again.',
    )
  }

  async function checkSignatureStatus() {
    if (!active || submittingRef.current) return
    submittingRef.current = true
    setPhase('checking')
    try {
      await reconcileSignature(active, 'No signature is recorded yet. You can try signing again.')
    } finally {
      submittingRef.current = false
    }
  }

  async function confirmSign() {
    if (!active || !gateway.signAgreement || submittingRef.current || phase === 'uncertain') return
    if (!downloadUrl || documentReadyUntil <= Date.now() || !acknowledged) {
      setActionError('Open the agreement PDF and acknowledge the terms before signing.')
      return
    }
    if (legalName.trim().length < 2) {
      setActionError('Enter your full legal name to sign.')
      return
    }
    const request = active
    submittingRef.current = true
    setPhase('signing')
    setActionError(null)
    try {
      const result = await gateway.signAgreement({
        documentId: request.documentId,
        legalName: legalName.trim(),
        acknowledged: true,
      })
      if (
        result.status === 'ready' &&
        result.data?.documentId === request.documentId &&
        result.data.agreementId === request.agreementId &&
        result.data.version === request.version
      ) {
        finishReview(
          request,
          `Signed as ${result.data.signerName}. KissMyApps will countersign next.`,
        )
        return
      }
      await reconcileSignature(
        request,
        result.error?.message ?? 'The signature could not be confirmed. Try again.',
      )
    } catch {
      await reconcileSignature(request, 'The signature could not be recorded. Try again.')
    } finally {
      submittingRef.current = false
    }
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

  const successNote = confirmation ? <StatusNotice success={confirmation} /> : null

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
          if (!open && !signing) setActive(null)
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
            {active.rules && active.rules.length > 0 && (
              <section aria-label="Commission policy to sign">
                <h3>Commission policy</h3>
                {active.rules.map((rule, index) => (
                  <PartnerRuleTerms
                    key={`${rule.name}:${index}`}
                    rule={rule}
                    currency={active.payoutCurrency}
                  />
                ))}
              </section>
            )}
            {active.termsSha256 && (
              <p className="field-hint" style={{ overflowWrap: 'anywhere' }}>
                Signed terms fingerprint: {active.termsSha256}
              </p>
            )}
            {downloadUrl ? (
              <a
                className="agreement-sign-download"
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Download size={16} aria-hidden="true" /> Open the agreement PDF
              </a>
            ) : documentError ? (
              <div role="alert">
                <p>{documentError}</p>
                <button className="button" type="button" onClick={reloadDocument}>
                  Reload document
                </button>
              </div>
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
                disabled={signing}
                autoComplete="name"
                aria-invalid={Boolean(actionError)}
              />
            </label>
            <p className="field-hint">
              Signing records your legal name, account, and the exact document version as immutable
              evidence.
            </p>
            <label className="field-hint agreement-sign-acknowledgement">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={!downloadUrl || signing}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I have read the agreement PDF, accept its terms, and am authorized to sign for this
                partner.
              </span>
            </label>
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
              {phase === 'uncertain' || phase === 'checking' ? (
                <button
                  className="button button-primary"
                  type="button"
                  disabled={signing}
                  onClick={() => void checkSignatureStatus()}
                >
                  {phase === 'checking' ? 'Checking status…' : 'Check signature status'}
                </button>
              ) : (
                <button
                  className="button button-primary"
                  type="button"
                  disabled={signing || !downloadUrl || !acknowledged}
                  onClick={() => void confirmSign()}
                >
                  {signing && <LoaderCircle className="spin" size={16} aria-hidden="true" />}
                  {signing ? 'Signing…' : 'Sign the agreement'}
                </button>
              )}
            </div>
          </div>
        )}
      </Dialog>

      {successNote}
    </>
  )
}
