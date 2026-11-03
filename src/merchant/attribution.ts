import type { Attribution, AttributionDomain } from './api'

/** A subdomain made from the project's name, or '' when the name gives too little. */
export function suggestedSubdomain(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug.length >= 3 ? slug : ''
}

/** The project's KissMyApps address. */
export function kmaDomain(view: Attribution): AttributionDomain | undefined {
  return view.domains.find((domain) => domain.kind === 'kma')
}

/** The subdomain part of the KissMyApps address, such as speaksix. */
export function subdomainOf(view: Attribution): string {
  const host = kmaDomain(view)?.host ?? ''
  return host.endsWith(`.${view.link_root}`) ? host.slice(0, -view.link_root.length - 1) : host
}

/** Every domain that answers links now: the app has to list each of them. */
export function liveHosts(view: Attribution): string[] {
  return view.domains.filter((domain) => domain.status === 'live').map((domain) => domain.host)
}

/** What goes in the iOS app's Associated Domains, one line per domain. */
export function associatedDomains(hosts: string[]): string {
  return hosts.map((host) => `applinks:${host}`).join('\n')
}

/** The intent filter that lets the Android app open links on these domains. */
export function androidIntentFilter(hosts: string[]): string {
  return [
    '<intent-filter android:autoVerify="true">',
    '  <action android:name="android.intent.action.VIEW" />',
    '  <category android:name="android.intent.category.DEFAULT" />',
    '  <category android:name="android.intent.category.BROWSABLE" />',
    '  <data android:scheme="https" />',
    ...hosts.map((host) => `  <data android:host="${host}" />`),
    '</intent-filter>',
  ].join('\n')
}

/** Fingerprints typed one per line, or separated by commas or spaces. */
export function fingerprintList(text: string): string[] {
  return text
    .split(/[\n,;]+|\s{2,}/)
    .map((value) => value.trim())
    .filter(Boolean)
}

export function validFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.replace(/[\s:]/g, ''))
}

export const CURRENCIES: Array<{ value: string; label: string }> = [
  ['USD', 'US dollar'],
  ['EUR', 'Euro'],
  ['GBP', 'British pound'],
  ['NGN', 'Nigerian naira'],
  ['GHS', 'Ghanaian cedi'],
  ['KES', 'Kenyan shilling'],
  ['ZAR', 'South African rand'],
  ['EGP', 'Egyptian pound'],
  ['CAD', 'Canadian dollar'],
  ['AUD', 'Australian dollar'],
  ['INR', 'Indian rupee'],
  ['BRL', 'Brazilian real'],
  ['MXN', 'Mexican peso'],
  ['TRY', 'Turkish lira'],
  ['AED', 'UAE dirham'],
  ['SAR', 'Saudi riyal'],
  ['JPY', 'Japanese yen'],
  ['CNY', 'Chinese yuan'],
  ['IDR', 'Indonesian rupiah'],
  ['PHP', 'Philippine peso'],
].map(([value, name]) => ({ value, label: `${value}, ${name}` }))

/** Media sources people often use, offered while typing one. */
export const SOURCE_SUGGESTIONS = [
  'facebook',
  'instagram',
  'tiktok',
  'google',
  'youtube',
  'x',
  'snapchat',
  'whatsapp',
  'telegram',
  'email',
  'sms',
  'qr',
  'influencer',
  'website',
]

const SOURCE_NAMES: Record<string, string> = {
  google_ads: 'Google Ads',
  meta: 'Meta',
  microsoft_ads: 'Microsoft Ads',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  google: 'Google',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp',
  snapchat: 'Snapchat',
  telegram: 'Telegram',
  email: 'Email',
  sms: 'SMS',
  qr: 'QR code',
  x: 'X',
}

/** A source's name for people: known ones by name, others as sent. */
export function sourceLabel(key: string | null): string {
  if (key === null) return 'Direct or unknown'
  return SOURCE_NAMES[key] ?? key
}

/** How a source was recognised, for the report's notes. */
export function sourceHint(key: string | null): string | null {
  if (key === null) return 'No link, ad or referring site'
  if (key === 'google_ads') return 'From a gclid on the landing page'
  if (key === 'meta') return 'From an fbclid: a Facebook or Instagram ad or post'
  if (key === 'microsoft_ads') return 'From an msclkid on the landing page'
  if (key.includes('.')) return 'Referring site'
  return null
}

/** A link's address made from its name, such as october-launch. */
export function suggestedPath(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
}

/** A link with the address settings that change its source for one ad. */
export function linkWithOverrides(url: string, overrides: Record<string, string>): string {
  const link = new URL(url)
  for (const [key, value] of Object.entries(overrides))
    if (value.trim()) link.searchParams.set(key, value.trim())
  return link.toString()
}

/** A QR code for a link, made in the browser: no outside service sees the link. */
export async function qrDataUrl(value: string): Promise<string> {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toDataURL(value, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 10,
    color: { dark: '#111111', light: '#ffffff' },
  })
}
