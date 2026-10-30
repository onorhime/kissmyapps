import { useState } from 'react'
import { Send } from 'lucide-react'
import { eventCatalogs, platformLabels } from '../data/sample'
import type { Platform, Project } from '../data/sample'
import { formatAgo } from '../format'
import { href, installPlatforms } from '../routes'
import type { InstallPlatform } from '../routes'
import { useLiveEvents, useNow, useStore } from '../store'
import { CodeBlock, CopyButton, PageHeader, Select } from '../ui/Primitives'

const platformNames: Record<InstallPlatform, string> = {
  web: 'Web',
  ios: 'iOS',
  android: 'Android',
  'react-native': 'React Native',
  flutter: 'Flutter',
  http: 'HTTP API',
}

type Step = { title: string; body: string; code?: Array<{ label: string; code: string }> }

function sampleEvent(project: Project) {
  const catalog = eventCatalogs[project.id] ?? []
  const event =
    catalog.find(
      (item) =>
        item.category !== 'Automatic' && item.status === 'live' && item.properties.length >= 2,
    ) ?? catalog.find((item) => item.status === 'live')
  if (!event)
    return { name: 'sign_up_completed', props: [['method', '"Email"']] as Array<[string, string]> }
  const props = event.properties
    .filter((spec) => spec.name !== 'session_id')
    .slice(0, 2)
    .map((spec): [string, string] => [
      spec.name,
      spec.values
        ? JSON.stringify(spec.values[0])
        : spec.range
          ? String(spec.range[1] - Math.round((spec.range[1] - spec.range[0]) / 3))
          : '"…"',
    ])
  return { name: event.name, props }
}

function stepsFor(
  platform: InstallPlatform,
  project: Project,
  key: string,
  serverKey: string,
): Step[] {
  const event = sampleEvent(project)
  const typeName = `${project.name.replace(/[^A-Za-z0-9]/g, '') || 'My'}App`
  const jsProps = `{ ${event.props.map(([name, value]) => `${name}: ${value}`).join(', ')} }`
  const identifyBody =
    'Call identify when someone signs in, so their events from every device join one profile. Call reset when they sign out.'
  switch (platform) {
    case 'web':
      return [
        {
          title: 'Install the package',
          body: 'Add the SDK to your site or web app.',
          code: [{ label: 'Terminal', code: 'npm install @kissmyapps/analytics' }],
        },
        {
          title: 'Start it with your client key',
          body: 'Run this once, as early as your app loads. Page views and sessions are tracked for you.',
          code: [
            {
              label: 'JavaScript',
              code: `import { kma } from '@kissmyapps/analytics'\n\nkma.init('${key}', {\n  autocapture: true,\n})`,
            },
            {
              label: 'Or a script tag',
              code: `<script\n  src="https://cdn.kissmyapps.dev/analytics/1.3/kma.min.js"\n  data-key="${key}"\n  defer\n></script>`,
            },
          ],
        },
        {
          title: 'Send an event',
          body: 'Name events after what the person did, in the past tense.',
          code: [{ label: 'JavaScript', code: `kma.track('${event.name}', ${jsProps})` }],
        },
        {
          title: 'Identify signed-in people',
          body: identifyBody,
          code: [
            {
              label: 'JavaScript',
              code: `kma.identify('usr_29481', { plan: 'Pro' })\n\n// When they sign out\nkma.reset()`,
            },
          ],
        },
      ]
    case 'ios':
      return [
        {
          title: 'Add the Swift package',
          body: 'In Xcode choose File, then Add Package Dependencies, and paste this URL. Use version 1.2.0 or later.',
          code: [{ label: 'Package URL', code: 'https://github.com/kissmyapps/kma-swift' }],
        },
        {
          title: 'Configure it when the app starts',
          body: 'Sessions, screen views and installs are tracked for you.',
          code: [
            {
              label: 'Swift',
              code: `import KissMyApps\n\n@main\nstruct ${typeName}: App {\n  init() {\n    KMA.configure(apiKey: "${key}")\n  }\n\n  var body: some Scene {\n    WindowGroup { ContentView() }\n  }\n}`,
            },
          ],
        },
        {
          title: 'Send an event',
          body: 'Events are queued on the device and sent in batches, so they survive a lost connection.',
          code: [
            {
              label: 'Swift',
              code: `KMA.track("${event.name}", properties: [\n${event.props.map(([name, value]) => `  "${name}": ${value},`).join('\n')}\n])`,
            },
          ],
        },
        {
          title: 'Identify signed-in people',
          body: identifyBody,
          code: [
            {
              label: 'Swift',
              code: `KMA.identify(userId: "usr_29481", traits: ["plan": "Pro"])\n\n// When they sign out\nKMA.reset()`,
            },
          ],
        },
      ]
    case 'android':
      return [
        {
          title: 'Add the dependency',
          body: 'In your app module’s build.gradle.kts.',
          code: [
            {
              label: 'Kotlin DSL',
              code: 'dependencies {\n  implementation("dev.kissmyapps:kma-android:1.2.0")\n}',
            },
          ],
        },
        {
          title: 'Start it in your Application class',
          body: 'Sessions, screen views and installs are tracked for you.',
          code: [
            {
              label: 'Kotlin',
              code: `class ${typeName} : Application() {\n  override fun onCreate() {\n    super.onCreate()\n    KMA.init(this, "${key}")\n  }\n}`,
            },
          ],
        },
        {
          title: 'Send an event',
          body: 'Events are queued on the device and sent in batches.',
          code: [
            {
              label: 'Kotlin',
              code: `KMA.track("${event.name}", mapOf(\n${event.props.map(([name, value]) => `  "${name}" to ${value},`).join('\n')}\n))`,
            },
          ],
        },
        {
          title: 'Identify signed-in people',
          body: identifyBody,
          code: [
            {
              label: 'Kotlin',
              code: `KMA.identify("usr_29481", mapOf("plan" to "Pro"))\n\n// When they sign out\nKMA.reset()`,
            },
          ],
        },
      ]
    case 'react-native':
      return [
        {
          title: 'Install the package',
          body: 'Then install the iOS pods.',
          code: [
            {
              label: 'Terminal',
              code: 'npm install @kissmyapps/analytics-react-native\ncd ios && pod install',
            },
          ],
        },
        {
          title: 'Start it in your root component',
          body: 'Run it once, outside render.',
          code: [
            {
              label: 'TypeScript',
              code: `import { kma } from '@kissmyapps/analytics-react-native'\n\nkma.init('${key}')`,
            },
          ],
        },
        {
          title: 'Send an event',
          body: 'The same calls as the web SDK.',
          code: [{ label: 'TypeScript', code: `kma.track('${event.name}', ${jsProps})` }],
        },
        {
          title: 'Identify signed-in people',
          body: identifyBody,
          code: [
            {
              label: 'TypeScript',
              code: `kma.identify('usr_29481', { plan: 'Pro' })\n\n// When they sign out\nkma.reset()`,
            },
          ],
        },
      ]
    case 'flutter':
      return [
        {
          title: 'Add the package',
          body: 'From your project folder.',
          code: [{ label: 'Terminal', code: 'flutter pub add kissmyapps_analytics' }],
        },
        {
          title: 'Start it before runApp',
          body: 'Sessions and installs are tracked for you.',
          code: [
            {
              label: 'Dart',
              code: `import 'package:kissmyapps_analytics/kma.dart';\n\nvoid main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  await Kma.init('${key}');\n  runApp(const ${typeName}());\n}`,
            },
          ],
        },
        {
          title: 'Send an event',
          body: 'Events are queued on the device and sent in batches.',
          code: [
            {
              label: 'Dart',
              code: `Kma.track('${event.name}', properties: {\n${event.props.map(([name, value]) => `  '${name}': ${value.replace(/"/g, "'")},`).join('\n')}\n});`,
            },
          ],
        },
        {
          title: 'Identify signed-in people',
          body: identifyBody,
          code: [
            {
              label: 'Dart',
              code: `Kma.identify('usr_29481', traits: {'plan': 'Pro'});\n\n// When they sign out\nKma.reset();`,
            },
          ],
        },
      ]
    case 'http':
      return [
        {
          title: 'Use a server key',
          body: 'The HTTP API is for your backend: webhooks, billing events and imports. Never put a server key in an app or a web page.',
        },
        {
          title: 'Send events in batches',
          body: 'Up to 500 events per request. time is optional and defaults to when the event arrives. insert_id stops a retried request from counting twice.',
          code: [
            {
              label: 'curl',
              code: `curl https://events.kissmyapps.dev/v1/events \\\n  -H "Authorization: Bearer ${serverKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "events": [{\n      "name": "subscription_started",\n      "user_id": "usr_29481",\n      "time": "2026-10-29T21:04:11Z",\n      "insert_id": "stripe_in_1QxW",\n      "properties": { "plan_id": "monthly_999", "price_usd": 9.99 }\n    }]\n  }'`,
            },
          ],
        },
        {
          title: 'Read the response',
          body: 'A 200 lists how many events were stored. A 400 names each event that was rejected and why. Retry on 429 and 5xx with backoff.',
          code: [{ label: 'Response', code: '{\n  "stored": 1,\n  "rejected": []\n}' }],
        },
      ]
  }
}

function defaultPlatform(project: Project): InstallPlatform {
  return (project.platforms.find((platform) => platform !== 'server') ?? 'web') as InstallPlatform
}

export function InstallScreen({
  project,
  platform,
}: {
  project: Project
  platform?: InstallPlatform
}) {
  const { keys, sendTestEvent, notify } = useStore()
  const events = useLiveEvents(project)
  const now = useNow()
  const current = platform ?? defaultPlatform(project)
  const clientKeys = keys.filter(
    (key) => key.projectId === project.id && key.kind === 'client' && !key.revokedAt && key.token,
  )
  const serverKey = keys.find(
    (key) => key.projectId === project.id && key.kind === 'server' && !key.revokedAt,
  )
  const [keyId, setKeyId] = useState(clientKeys[0]?.id ?? '')
  const key = clientKeys.find((item) => item.id === keyId) ?? clientKeys[0]
  const token = key?.token ?? 'YOUR_CLIENT_KEY'
  const serverToken = serverKey ? `kma_sk_live_••••${serverKey.suffix}` : 'YOUR_SERVER_KEY'
  const steps = stepsFor(current, project, token, serverToken)
  const testPlatform: Platform = project.platforms.includes('web') ? 'web' : project.platforms[0]
  const received = events.length > 0

  return (
    <div className="mc-page">
      <PageHeader
        title="Install the SDK"
        description={`Send events from ${project.name} in a few minutes. Pick the platform you build with.`}
      />
      <div className="mc-tabs is-wide" role="tablist" aria-label="Platform">
        {installPlatforms.map((item) => (
          <a
            key={item}
            role="tab"
            aria-selected={item === current}
            href={href({ name: 'install', projectId: project.id, platform: item })}
          >
            {platformNames[item]}
          </a>
        ))}
      </div>
      <div className="mc-install">
        <ol className="mc-install-steps">
          {steps.map((step) => (
            <li key={step.title}>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
              {step.code?.map((block) => (
                <CodeBlock key={block.label} code={block.code} label={block.label} />
              ))}
              {current === 'http' && step.title === 'Use a server key' && (
                <a
                  className="mc-btn mc-btn-secondary"
                  href={href({ name: 'settings', projectId: project.id, section: 'keys' })}
                >
                  {serverKey ? 'Manage server keys' : 'Create a server key'}
                </a>
              )}
            </li>
          ))}
        </ol>
        <aside className="mc-install-rail">
          <section className="mc-panel" aria-labelledby="mc-key-title">
            <div className="mc-panel-head">
              <h2 id="mc-key-title">{current === 'http' ? 'Server key' : 'Client key'}</h2>
              <p className="mc-muted">
                {current === 'http'
                  ? 'Server keys are only shown once, when they are created.'
                  : 'Safe to ship in apps and web pages. It can only send events.'}
              </p>
            </div>
            {current === 'http' ? (
              <p className="mc-key-value mc-mono">{serverToken}</p>
            ) : clientKeys.length ? (
              <>
                {clientKeys.length > 1 && (
                  <Select
                    label="Key"
                    value={key?.id ?? ''}
                    onChange={setKeyId}
                    options={clientKeys.map((item) => ({
                      value: item.id,
                      label: `${item.name} (${item.environment === 'production' ? 'production' : 'development'})`,
                    }))}
                  />
                )}
                <div className="mc-key-row">
                  <span className="mc-key-value mc-mono">{token}</span>
                  <CopyButton value={token} label="client key" compact />
                </div>
              </>
            ) : (
              <p className="mc-muted">This project has no active client key.</p>
            )}
            <a
              className="mc-link"
              href={href({ name: 'settings', projectId: project.id, section: 'keys' })}
            >
              Manage keys
            </a>
          </section>

          <section className="mc-panel" aria-labelledby="mc-check-title">
            <div className="mc-panel-head">
              <h2 id="mc-check-title">Check your setup</h2>
              <p className="mc-muted">Each source turns green when its first event arrives.</p>
            </div>
            <ul className="mc-check-list" aria-live="polite">
              {project.platforms.map((item) => {
                const last = events.find((event) => event.platform === item)
                const quiet = last && project.quietSource?.platform === item
                return (
                  <li key={item}>
                    <span
                      className={
                        quiet
                          ? 'mc-status-dot is-warning'
                          : last
                            ? 'mc-status-dot is-on'
                            : 'mc-status-dot'
                      }
                      aria-hidden="true"
                    />
                    <strong>{platformLabels[item]}</strong>
                    <span className={quiet ? 'mc-warning-text' : 'mc-muted'}>
                      {last
                        ? `${quiet ? 'Quiet, last event' : 'Last event'} ${formatAgo(last.time, now)}`
                        : 'Waiting for an event'}
                    </span>
                  </li>
                )
              })}
            </ul>
            <button
              type="button"
              className="mc-btn mc-btn-secondary"
              onClick={() => {
                sendTestEvent(project.id, testPlatform)
                notify(`Test event received from ${platformLabels[testPlatform]}.`)
              }}
            >
              <Send size={16} aria-hidden="true" />
              Send a test event
            </button>
            {received && (
              <a className="mc-link" href={href({ name: 'live', projectId: project.id })}>
                See it in Live events
              </a>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
