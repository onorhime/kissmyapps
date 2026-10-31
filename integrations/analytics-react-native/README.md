<p align="center">
  <a href="https://kissmyapps.dev">
    <img src="https://raw.githubusercontent.com/onorhime/kissmyapps-mobile/main/.github/assets/kissmyapps.png" width="88" height="88" alt="KissMyApps">
  </a>
</p>

<h1 align="center">KissMyApps for React Native</h1>

<p align="center">
  Installs, sessions, screens and your own events, from your app to your KissMyApps dashboard.<br>
  Plain JavaScript: nothing to link, works with Expo.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kissmyappss/react-native"><img src="https://img.shields.io/npm/v/@kissmyappss/react-native?color=ff80bf&labelColor=222222" alt="npm"></a>
  <img src="https://img.shields.io/badge/React%20Native-0.70%2B-ff80bf?logo=react&logoColor=white&labelColor=222222" alt="React Native 0.70+">
  <img src="https://img.shields.io/badge/Expo-ready-ff80bf?logo=expo&logoColor=white&labelColor=222222" alt="Expo">
  <img src="https://img.shields.io/badge/TypeScript-included-ff80bf?logo=typescript&logoColor=white&labelColor=222222" alt="TypeScript">
  <img src="https://img.shields.io/badge/license-MIT-ff80bf?labelColor=222222" alt="MIT licence">
</p>

---

## Why this SDK

- **Start it and you are done.** Installs, updates, opens, time in the app and sessions are
  recorded on their own; React Navigation screens take one line.
- **Nothing is lost offline.** Events wait in storage, survive a restart and go out with
  backoff once there is a connection.
- **No native code.** Pure JavaScript with TypeScript types, so it works in Expo Go and needs
  no `pod install`.
- **Respectful by default.** A random ID per install, no advertising ID, no fingerprinting,
  and an opt-out that is remembered across launches.
- **One dashboard for every platform.** It sends the same events as the
  [iOS and Android SDKs](https://github.com/onorhime/kissmyapps-mobile) and the web script.

## Install

```sh
npm install @kissmyappss/react-native @react-native-async-storage/async-storage
```

With Expo, `npx expo install @kissmyappss/react-native @react-native-async-storage/async-storage`.

You need React Native 0.70 or later, and a **client key** from your project in the
KissMyApps console under **Settings → API keys**. Keys starting `kma_pk_live_` count as
production; keys starting `kma_pk_test_` are kept apart as development.

## Quick start

Start the SDK once, as early as possible, for example at the top of `App.tsx`:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage'
import { KissMyApps } from '@kissmyappss/react-native'

KissMyApps.init({
  key: 'kma_pk_live_…',
  storage: AsyncStorage,
  appVersion: '2.4.0', // for example DeviceInfo.getVersion()
  build: '120', //        and DeviceInfo.getBuildNumber()
})
```

<details>
<summary>Version and build with Expo</summary>

```tsx
import * as Application from 'expo-application'

KissMyApps.init({
  key: 'kma_pk_live_…',
  storage: AsyncStorage,
  appVersion: Application.nativeApplicationVersion ?? undefined,
  build: Application.nativeBuildVersion ?? undefined,
})
```

</details>

Storage is what lets the SDK recognise a returning person and keep events through a restart.
Without it the SDK still works, but every launch counts as a new install.

## Track what matters

### Screens

With React Navigation, pass the helper to the container and every screen is recorded under
its route name:

```tsx
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native'
import { trackNavigation } from '@kissmyappss/react-native'

export function App() {
  const navigation = useNavigationContainerRef()
  return (
    <NavigationContainer ref={navigation} {...trackNavigation(navigation)}>
      {/* your navigators */}
    </NavigationContainer>
  )
}
```

Without React Navigation, call `KissMyApps.screen('Lesson')` when a screen appears.

### Events and people

```ts
KissMyApps.track('lesson_completed', { lesson: 3, score: 0.92 })

KissMyApps.identify('user-42', { email: 'amaka@example.com', plan: 'annual' })
KissMyApps.setTraits({ plan: 'monthly' })
KissMyApps.reset() // on sign out: what follows belongs to a new, anonymous person

KissMyApps.optOut() // stops sending, remembered across launches
KissMyApps.optIn()
await KissMyApps.flush()
```

Event names use letters, numbers and `_ . : -`, start with a letter and are up to 80
characters; other names are ignored. Calls made before `init` are kept and run once it is
called.

### Everything at a glance

| Call                               | What it does                                          |
| ---------------------------------- | ----------------------------------------------------- |
| `KissMyApps.init(options)`         | Starts recording. Call once.                          |
| `KissMyApps.track(name, props?)`   | Records one of your events.                           |
| `KissMyApps.screen(name, props?)`  | Records a screen view.                                |
| `trackNavigation(ref)`             | Records every React Navigation screen.                |
| `KissMyApps.identify(id, traits?)` | Ties this install to your user ID.                    |
| `KissMyApps.setTraits(traits)`     | Updates what you know about the person.               |
| `KissMyApps.reset()`               | Forgets the person and starts a new anonymous one.    |
| `KissMyApps.optOut()` / `optIn()`  | Stops or resumes sending. Remembered across launches. |
| `KissMyApps.flush()`               | Sends what is queued now; returns a promise.          |
| `KissMyApps.getAnonymousId()`      | This install's random ID, for support tickets.        |
| `KissMyApps.getSessionId()`        | The current session's ID.                             |

## What gets recorded

| Event              | When                                       | Properties                                               |
| ------------------ | ------------------------------------------ | -------------------------------------------------------- |
| `session_started`  | A new session begins                       | –                                                        |
| `app_installed`    | The first launch after install             | `version`, `build`                                       |
| `app_updated`      | The first launch of a new version or build | `version`, `build`, `previous_version`, `previous_build` |
| `app_opened`       | The app comes to the foreground            | `from_background`                                        |
| `app_backgrounded` | The app leaves the foreground              | `seconds_in_foreground`                                  |
| `screen_viewed`    | A screen appears                           | `name`, `previous`, plus your own                        |

Every request also carries iOS or Android and the OS version, phone or tablet, the device
model on Android (iPhone or iPad on iOS), screen size, language, time zone, app version and
the SDK version. Country, region and city are worked out by the KissMyApps server from the
request's address, which is only ever kept as a salted hash. There is no advertising ID.

A session ends after 30 minutes in the background or without events. Events are sent every
10 seconds, at once when 30 are waiting, and when the app goes to the background. While
offline they wait in storage (up to 1,000, oldest dropped first) and are retried with
backoff, including on the next launch.

## Options

| Option                  | Default                         | What it does                                                   |
| ----------------------- | ------------------------------- | -------------------------------------------------------------- |
| `key`                   | Required                        | The project's client key.                                      |
| `storage`               | None                            | AsyncStorage or anything with `getItem` and `setItem`.         |
| `appVersion`            | None                            | The version shown in the dashboard.                            |
| `build`                 | None                            | The build number, used to spot updates.                        |
| `endpoint`              | `https://events.kissmyapps.dev` | Where events are sent.                                         |
| `sessionTimeoutMinutes` | `30`                            | Minutes in the background or idle before a new session starts. |
| `flushIntervalSeconds`  | `10`                            | How often queued events are sent while the app is open.        |
| `maxQueue`              | `1000`                          | The most events kept while offline.                            |
| `trackLifecycle`        | `true`                          | Record installs, updates, opens and backgrounding.             |
| `debug`                 | `false`                         | Log refused events and other problems to the console.          |

## License

MIT © KissMyApps
