// No third-party QR service receives tracking URLs. Generate locally on demand.
export async function previewQrDataUrl(value: string) {
  const url = new URL(value)
  if (
    url.origin !== 'https://go.example.invalid' ||
    url.username ||
    url.password ||
    !(url.pathname === '/r/preview-partner' || url.pathname.startsWith('/r/preview-partner/'))
  ) {
    throw new Error('Only reserved sample tracking URLs can be encoded in this preview.')
  }
  const { default: QRCode } = await import('qrcode')
  return QRCode.toDataURL(value, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 8,
    color: { dark: '#193b2d', light: '#ffffff' },
  })
}
