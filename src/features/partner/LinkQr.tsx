import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { previewQrDataUrl } from './qrData'

export function LinkQr({
  url,
  name,
  fileKey,
  onBack,
  autoFocusHeading = false,
}: {
  url: string
  name: string
  fileKey: string
  onBack: () => void
  autoFocusHeading?: boolean
}) {
  const [image, setImage] = useState('')
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (autoFocusHeading) heading.current?.focus()
  }, [autoFocusHeading])
  useEffect(() => {
    let current = true
    previewQrDataUrl(url).then(
      (value) => {
        if (current) setImage(value)
      },
      () => {
        if (current) setError(true)
      },
    )
    return () => {
      current = false
    }
  }, [url, attempt])
  return (
    <div className="link-qr-preview">
      <h3 ref={heading} tabIndex={-1}>
        A QR for {name}
      </h3>
      <p>
        Encodes the exact sample tracked URL below. Generated on this device; no external QR service
        is used. This .invalid link cannot receive traffic.
      </p>
      {image ? (
        <img
          src={image}
          alt={`Sample QR for ${name}; equivalent URL is provided below`}
          className="link-qr-image"
        />
      ) : error ? (
        <div role="alert">
          <p>The QR could not be prepared. You can still select and copy its URL.</p>
          <button
            className="button button-white"
            onClick={() => {
              setError(false)
              setAttempt((value) => value + 1)
            }}
          >
            Retry QR
          </button>
        </div>
      ) : (
        <p role="status">Preparing sample QR…</p>
      )}
      <label className="form-field">
        QR destination
        <textarea readOnly rows={4} value={url} onFocus={(event) => event.target.select()} />
      </label>
      <p className="detail-notice" role="status">
        {notice}
      </p>
      <div className="dialog-actions">
        <button className="button button-white" onClick={onBack}>
          Back to link
        </button>
        {image ? (
          <a
            className="button button-green"
            href={image}
            download={`SAMPLE-${fileKey.replace(/[^a-zA-Z0-9_-]/g, '-')}-QR.png`}
            onClick={() =>
              setNotice('Sample QR download requested. It does not create a live link.')
            }
          >
            <ArrowDownToLine size={15} />
            Download sample QR PNG
          </a>
        ) : (
          <button className="button button-green" disabled>
            Download sample QR PNG
          </button>
        )}
      </div>
    </div>
  )
}
