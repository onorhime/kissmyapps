import type {
  Acquisition,
  Attribution,
  AttributionDomain,
  AttributionLink,
  AttributionSettings,
  AttributionSources,
  AttributionTestDevice,
  InstallMethod,
  Project,
  SourceRow,
} from './api'
import { ANALYTICS_ENDPOINT, MOBILE_SDK, jitpackArtifact } from './config'

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
  apple_ads: 'Apple Ads',
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
  if (key === 'apple_ads') return 'App installs Apple matched to a search ad'
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

// App installs and deep links -------------------------------------------------------------------
//
// Every answer about installs is read here, and an older database (one without app installs)
// reads as none: a missing number is 0, a missing object is null.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const time = (value: unknown) => {
  const at = text(value)
  return at && !Number.isNaN(Date.parse(at)) ? at : null
}

export const INSTALL_METHODS: InstallMethod[] = [
  'link_open',
  'install_referrer',
  'apple_ads',
  'clipboard',
  'login',
  'organic',
  'reinstall',
]
const installMethod = (value: unknown): InstallMethod | null =>
  INSTALL_METHODS.includes(value as InstallMethod) ? (value as InstallMethod) : null

/** Whether the project has an app, so installs mean something for it. */
export function hasApp(project: Project, settings: AttributionSettings | null): boolean {
  return (
    project.platforms.includes('ios') ||
    project.platforms.includes('android') ||
    Boolean(settings?.ios_bundle_id || settings?.ios_app_store_id || settings?.android_package)
  )
}

/** Whether the project has an iPhone app. */
export function hasIos(project: Project, settings: AttributionSettings | null): boolean {
  return (
    project.platforms.includes('ios') ||
    Boolean(settings?.ios_bundle_id || settings?.ios_app_store_id)
  )
}

/** Installs matched so far for the project. */
export function installsOf(view: Attribution): { total: number; last_at: string | null } {
  const installs: unknown = view.installs
  if (!isRecord(installs)) return { total: 0, last_at: null }
  return { total: count(installs.total), last_at: time(installs.last_at) }
}

/** A link's installs and re-engagements in the report's range. */
export function linkInstalls(link: AttributionLink): { installs: number; reengagements: number } {
  return { installs: count(link.installs), reengagements: count(link.reengagements) }
}

/** A source's counted installs in the report's range. */
export function sourceInstalls(row: SourceRow): number {
  return count(row.installs)
}

/** The report's installs: its own total when it sends one, else the rows added up. */
export function totalInstalls(report: AttributionSources): number {
  const total: unknown = report.totals.installs
  return typeof total === 'number'
    ? count(total)
    : report.rows.reduce((sum, row) => sum + sourceInstalls(row), 0)
}

/** Whether clipboard handoff for iPhone is on. */
export function clipboardHandoff(view: Attribution): boolean {
  return view.settings?.ios_clipboard_handoff === true
}

/** How an install was matched, after "matched by". */
export const METHOD_WORDS: Record<InstallMethod, string> = {
  link_open: 'a link that opened the app',
  install_referrer: 'Google Play install referrer',
  apple_ads: 'Apple Ads',
  clipboard: 'clipboard handoff',
  login: 'sign-in after a web visit',
  organic: 'no link (organic)',
  reinstall: 'a reinstall of an earlier install',
}

/** Exact: the install carried the click itself. Likely: it was worked out. */
export function exactWord(exact: boolean): string {
  return exact ? 'exact' : 'likely'
}

/** Where a person's app install came from, or null when there is none to show. */
export function readAcquisition(value: unknown): Acquisition | null {
  if (!isRecord(value)) return null
  const method = installMethod(value.method)
  if (!method) return null
  return {
    source: text(value.source),
    campaign: text(value.campaign),
    method,
    exact: value.exact === true,
    installed_at: time(value.installed_at),
    link_name: text(value.link_name),
    // An older answer has no verdict: an install it sends counts.
    verdict:
      value.verdict === 'flagged' || value.verdict === 'rejected' ? value.verdict : 'counted',
  }
}

/**
 * One sentence on where a person came from: "Acquired from TikTok, launch, matched by Google
 * Play install referrer (exact)".
 */
export function acquisitionLine(acquisition: Acquisition): string {
  // A rejected install credits nobody. Its one reason: the click came after the install.
  if (acquisition.verdict === 'rejected')
    return 'Install not counted: the click came after the install'
  if (acquisition.method === 'organic') return 'Installed with no link (organic)'
  if (!acquisition.source) return 'Installed, with no source credited'
  const campaign = acquisition.campaign ? `, ${acquisition.campaign}` : ''
  const review = acquisition.verdict === 'flagged' ? ', marked for review' : ''
  return `Acquired from ${sourceLabel(acquisition.source)}${campaign}, matched by ${METHOD_WORDS[acquisition.method]} (${exactWord(acquisition.exact)})${review}`
}

const clickPlatform = (value: unknown) =>
  value === 'ios' || value === 'android' || value === 'desktop' ? value : null
const appPlatform = (value: unknown) => (value === 'ios' || value === 'android' ? value : null)

/** What the phone test saw for one link; a missing or partial answer reads as nothing yet. */
export function readTestDevice(value: unknown, linkId: string): AttributionTestDevice {
  const answer = isRecord(value) ? value : {}
  const link = isRecord(answer.link) ? answer.link : {}
  const click = isRecord(answer.click) ? answer.click : null
  const install = isRecord(answer.install) ? answer.install : null
  const clickAt = time(click?.at)
  const installAt = time(install?.at)
  const method = installMethod(install?.method)
  return {
    link: { id: text(link.id) ?? linkId, url: text(link.url) },
    click: clickAt ? { at: clickAt, platform: clickPlatform(click?.platform) ?? 'desktop' } : null,
    install:
      installAt && method
        ? {
            at: installAt,
            method,
            platform: appPlatform(install?.platform) ?? 'ios',
            exact: install?.exact === true,
          }
        : null,
    deep_link_delivered: answer.deep_link_delivered === true,
  }
}

export type CheckState = 'done' | 'waiting' | 'later' | 'warning' | 'off'
export type Check = { key: 'click' | 'install' | 'deep_link'; label: string; state: CheckState }

/** The three checks of a phone test, in order, from what the database saw. */
export function testChecks(device: AttributionTestDevice | null, opensScreen: boolean): Check[] {
  const clicked = Boolean(device?.click)
  const fromPhone = clicked && device?.click?.platform !== 'desktop'
  const install = device?.install ?? null
  const matched = Boolean(install && install.method !== 'organic')
  return [
    {
      key: 'click',
      label: 'Click received',
      state: !clicked ? 'waiting' : fromPhone ? 'done' : 'warning',
    },
    {
      key: 'install',
      label: 'Install matched',
      state: matched ? 'done' : install ? 'warning' : clicked ? 'waiting' : 'later',
    },
    {
      key: 'deep_link',
      label: 'Deep link delivered',
      state: !opensScreen
        ? 'off'
        : device?.deep_link_delivered
          ? 'done'
          : matched
            ? 'waiting'
            : 'later',
    },
  ]
}

/** Whether a phone test has nothing left to wait for. */
export function testFinished(checks: Check[]): boolean {
  return checks.every((check) => check.state === 'done' || check.state === 'off')
}

/** A click's device in words. */
export function devicePhrase(platform: 'ios' | 'android' | 'desktop'): string {
  return platform === 'ios' ? 'iPhone' : platform === 'android' ? 'Android phone' : 'a computer'
}

export type SdkPlatform = 'ios' | 'android' | 'react-native' | 'flutter'

const DEFAULT_ENDPOINT = 'https://events.kissmyapps.dev'

/**
 * The code for links and installs with SDK 1.1, per platform, for the project's key, its live
 * link domains and whether clipboard handoff is on.
 */
export function sdkSnippets({ key, clipboard }: { key: string; clipboard: boolean }) {
  // App SDKs send to the default endpoint unless told otherwise, as on a local stack.
  const endpoint = ANALYTICS_ENDPOINT !== DEFAULT_ENDPOINT ? ANALYTICS_ENDPOINT : null
  const swiftOptions = [
    endpoint && `endpoint: "${endpoint}"`,
    clipboard && 'clipboardHandoff: true',
  ].filter(Boolean)
  // Inside init(), so the lines after the first are indented by eight spaces.
  const iosStart = swiftOptions.length
    ? `KissMyApps.start(\n            key: "${key}",\n            options: KissMyAppsOptions(${swiftOptions.join(', ')})\n        )`
    : `KissMyApps.start(key: "${key}")`
  const jsOptions = [
    `  key: '${key}',`,
    endpoint && `  endpoint: '${endpoint}',`,
    '  storage: AsyncStorage,',
    clipboard && "  // Reads the click a link's iPhone page copied, on the first launch",
    clipboard && '  clipboardHandoff: true,',
  ].filter(Boolean)
  const dartOptions = [
    endpoint && `endpoint: '${endpoint}'`,
    clipboard && 'clipboardHandoff: true',
  ].filter(Boolean)
  const flutterStart = dartOptions.length
    ? `KissMyApps.start(\n    '${key}',\n    options: const KissMyAppsOptions(${dartOptions.join(', ')}),\n  );`
    : `KissMyApps.start('${key}');`
  return {
    iosCode: `import KissMyApps
import SwiftUI

@main
struct MyApp: App {
    init() {
        ${iosStart}
        // The screen a link points to: from the link that opened the app,
        // or the one that brought the install. Each link arrives once.
        KissMyApps.onDeepLink { link in
            guard let screen = link.value else { return }
            Router.shared.open(screen, params: link.params)
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .onOpenURL { KissMyApps.handleDeepLink($0) }
        }
    }
}`,
    androidGradle: `// app/build.gradle.kts
dependencies {
    implementation("${jitpackArtifact()}")
}`,
    androidCode: `import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import com.kissmyapps.KissMyApps

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The screen a link points to: from the link that opened the app,
        // or the one that brought the install. Each link arrives once.
        KissMyApps.onDeepLink { link ->
            link.value?.let { screen -> navController.navigate(screen) }
        }
        // Once per link: not again when the activity is recreated, such as after a rotation.
        if (savedInstanceState == null) KissMyApps.handleDeepLink(intent)
    }

    // A link that opens the app while this activity is already running.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        KissMyApps.handleDeepLink(intent)
    }
}`,
    reactNativeInstall: `npm install ${MOBILE_SDK.npmPackage}@^${MOBILE_SDK.version}
cd ios && pod install`,
    reactNativeCode: `import AsyncStorage from '@react-native-async-storage/async-storage'
import { KissMyApps } from '${MOBILE_SDK.npmPackage}'

KissMyApps.init({
${jsOptions.join('\n')}
})

// The screen a link points to: from the link that opened the app,
// or the one that brought the install. Each link arrives once.
KissMyApps.onDeepLink((link) => {
  if (link.value) navigationRef.navigate(link.value, link.params)
})

// The SDK reads the link that opened the app by itself. Pass on
// any link your app receives another way:
KissMyApps.handleDeepLink(url)`,
    flutterInstall: `flutter pub add ${MOBILE_SDK.pubPackage}:^${MOBILE_SDK.version}`,
    flutterCode: `import 'package:flutter/material.dart';
import 'package:kissmyapps/kissmyapps.dart';

final navigatorKey = GlobalKey<NavigatorState>();

void main() {
  ${flutterStart}
  // The screen a link points to: from the link that opened the app,
  // or the one that brought the install. Each link arrives once.
  KissMyApps.onDeepLink((link) {
    final screen = link.value;
    if (screen != null) {
      navigatorKey.currentState?.pushNamed(screen, arguments: link.params);
    }
  });
  runApp(MaterialApp(navigatorKey: navigatorKey, home: const HomeScreen()));
}`,
  }
}
