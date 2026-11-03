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
