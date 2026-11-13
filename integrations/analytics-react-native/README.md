<p align="center">
  <a href="https://kissmyapps.dev">
    <img src="https://raw.githubusercontent.com/onorhime/kissmyapps-mobile/main/.github/assets/kissmyapps.png" width="88" height="88" alt="KissMyApps">
  </a>
</p>

<h1 align="center">KissMyApps for React Native</h1>

<p align="center">
  Installs, sessions, screens, your own events, install attribution and deep links, from your app to your KissMyApps dashboard.<br>
  Plain JavaScript that works with Expo, plus an optional native module for exact install matching.
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
- **Know which link brought each install.** On the first launch the SDK matches the install
  to the smart link that brought it and hands your app the link's deep link, even when the
  person had to install the app first.
- **Native code only if you want it.** The core is plain JavaScript with TypeScript types, so
  it works in Expo Go. The small optional native module adds the device key, the Google Play
  install referrer and the Apple Ads token; it links itself.
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
Without it the SDK still works, but every launch counts as a new install (and installs are
not matched to links).

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
| `KissMyApps.onDeepLink(handler)`   | Receives deep links; returns a function to stop.      |
| `KissMyApps.handleDeepLink(url)`   | Reports a link that opened the app another way.       |
| `KissMyApps.identify(id, traits?)` | Ties this install to your user ID.                    |
| `KissMyApps.setTraits(traits)`     | Updates what you know about the person.               |
| `KissMyApps.reset()`               | Forgets the person and starts a new anonymous one.    |
| `KissMyApps.optOut()` / `optIn()`  | Stops or resumes sending. Remembered across launches. |
| `KissMyApps.flush()`               | Sends what is queued now; returns a promise.          |
| `KissMyApps.getAnonymousId()`      | This install's random ID, for support tickets.        |
| `KissMyApps.getSessionId()`        | The current session's ID.                             |

## Install attribution and deep links

Smart links (`https://<you>.go.kissmyapps.dev/…`, or your own domain) send people to the App
Store, Google Play or your website, and open your app when it is installed. With attribution
turned on for the project in the console, the SDK:

- on the **first launch**, right after `app_installed`, asks KissMyApps once which link brought
  the install, and hands you that link's deep link (a _deferred_ deep link);
- each time a **smart link opens the app** later, reports it and hands you its deep link.

```tsx
import { KissMyApps } from '@kissmyappss/react-native'

// For example next to your navigation container, as early as you can.
useEffect(
  () =>
    KissMyApps.onDeepLink((link) => {
      // link.value: the deep link value you set on the smart link, such as 'lesson'
      // link.params: its parameters as text, such as { id: '4' }
      // link.deferred: true after an install, false when a link opened the app
      // link.url: the link that opened the app, or null after a store install
      if (link.value === 'lesson') navigation.navigate('Lesson', { id: link.params.id })
    }),
  [],
)
```

Each deep link is handed over once. One that arrives before you set a handler waits for it
(only the newest is kept). `onDeepLink` returns a function that removes the handler.

The SDK reads the link that opened the app (`Linking.getInitialURL()`) and links opened while
it runs (Linking's `url` events) by itself, so your own linking setup (React Navigation's
`linking`, Expo Router) keeps working as it is. If a link reaches your app some other way,
pass it on with `KissMyApps.handleDeepLink(url)`; it returns `false` when nothing is sent (not
an https link, attribution off, opted out). The same link reported twice within 3 seconds
counts once.

The install call is made once. If the phone is offline it is tried again on the next three
launches, with the same details. Until attribution is on for the project, both calls answer
"off" and nothing is stored.

### Let your app open your links

The console's **Attribution → Setup** shows the exact lines for your link domains. The
[iOS and Android SDK guide](https://github.com/onorhime/kissmyapps-mobile#attribution-and-deep-links) explains
them in full; in short:

- **iOS:** in Xcode, under **Signing & Capabilities**, add **Associated Domains** with
  `applinks:<your link domain>`. React Native's `Linking` needs the app delegate to pass
  Universal Links on, as in React Native's
  [linking guide](https://reactnative.dev/docs/linking#enabling-deep-links):

  ```objc
  // AppDelegate.mm
  #import <React/RCTLinkingManager.h>

  - (BOOL)application:(UIApplication *)application
      continueUserActivity:(NSUserActivity *)userActivity
        restorationHandler:(void (^)(NSArray<id<UIUserActivityRestoring>> *))restorationHandler
  {
    return [RCTLinkingManager application:application
                     continueUserActivity:userActivity
                       restorationHandler:restorationHandler];
  }
  ```

- **Android:** in `AndroidManifest.xml`, inside the activity that opens links, an intent
  filter with `android:autoVerify="true"` for `https` and your link domains.

- **Expo:** set `ios.associatedDomains` (`["applinks:<your link domain>"]`) and
  `android.intentFilters` (with `autoVerify: true`) in `app.json`; Expo writes both for you.

### The optional native module

The package brings a small native module, `KissMyAppsAttribution`, that React Native's
autolinking adds to your app: run `cd ios && pod install` after installing; Android needs
nothing. It adds to the install call:

| Field           | Platform | What it gives                                                                                                                                                                        |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Device key      | Both     | A SHA-256 hash of `identifierForVendor` (iOS) or `ANDROID_ID` (Android), so a reinstall is recognised and not counted (or paid) twice. The identifier itself never leaves the phone. |
| Play referrer   | Android  | The Google Play install referrer, which names the exact click that led to the install.                                                                                               |
| Apple Ads       | iOS      | The Apple Ads attribution token, on iOS 14.3 and later, for installs from Apple Search Ads.                                                                                          |
| Clipboard click | iOS      | With `clipboardHandoff` on, the click ID the smart link's page copied (see below).                                                                                                   |

Without the module, as in **Expo Go**, the install call still runs, without those fields: an
install is still matched when a smart link opens the app on its first launch (or when the
person signs in on a site that saw the click), but not from the Play referrer, Apple Ads or
the clipboard, and a reinstall is not recognised. The module works in **Expo development
builds** and **bare** apps (`npx expo prebuild` links it like any native module). There is
no Expo config plugin: the module needs none, and your link domains go in `app.json` as
above.

**Clipboard handoff for iPhone.** The App Store passes nothing from the link to the app, so
an iPhone install that no link opens is otherwise matched only through Apple Ads or a later
sign-in. With
**Clipboard handoff for iPhone** on in the console, the smart link's page copies the click
before opening the App Store; turn on `clipboardHandoff: true` too and the SDK reads it on the
first launch. iOS asks the person before an app reads what another app copied, so this is off
by default.

No advertising identifier is used (no IDFA, no GAID, no `AD_ID` permission) and no tracking
prompt is shown. The iOS pod brings a privacy manifest that declares the device ID and product
interaction, used for analytics and not for tracking.

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
The two attribution calls send what is described under
[Install attribution and deep links](#install-attribution-and-deep-links).

A session ends after 30 minutes in the background or without events. Events are sent every
10 seconds, at once when 30 are waiting, and when the app goes to the background. While
offline they wait in storage (up to 1,000, oldest dropped first) and are retried with
backoff, including on the next launch.

## Options

| Option                  | Default                         | What it does                                                    |
| ----------------------- | ------------------------------- | --------------------------------------------------------------- |
| `key`                   | Required                        | The project's client key.                                       |
| `storage`               | None                            | AsyncStorage or anything with `getItem` and `setItem`.          |
| `appVersion`            | None                            | The version shown in the dashboard.                             |
| `build`                 | None                            | The build number, used to spot updates.                         |
| `endpoint`              | `https://events.kissmyapps.dev` | Where events are sent.                                          |
| `sessionTimeoutMinutes` | `30`                            | Minutes in the background or idle before a new session starts.  |
| `flushIntervalSeconds`  | `10`                            | How often queued events are sent while the app is open.         |
| `maxQueue`              | `1000`                          | The most events kept while offline.                             |
| `trackLifecycle`        | `true`                          | Record installs, updates, opens and backgrounding.              |
| `attribution`           | `true`                          | Match the install to a link and report links that open the app. |
| `deepLinks`             | `true`                          | Read links from `Linking`; off, call `handleDeepLink` yourself. |
| `clipboardHandoff`      | `false`                         | iPhone: read the click the smart link's page copied.            |
| `debug`                 | `false`                         | Log refused events and other problems to the console.           |

## License

MIT © KissMyApps
