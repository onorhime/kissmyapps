# KissMyApps for React Native

Sends what people do in your app to your KissMyApps project: installs,
updates, opens, sessions, screens and your own events. It is plain
JavaScript, so there is no native code to link and it works with Expo.

React Native 0.70 or later.

## Install

```sh
npm install @kissmyapps/react-native @react-native-async-storage/async-storage
```

Start it once, as early as possible (for example in `App.tsx`), with the
project's client key from **Settings > API keys** in the console:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage'
import { KissMyApps } from '@kissmyapps/react-native'

KissMyApps.init({
  key: 'kma_pk_live_…',
  storage: AsyncStorage,
  appVersion: '2.4.0', // or DeviceInfo.getVersion()
  build: '120',
})
```

Without storage the SDK still works, but every launch counts as a new
install by a new person and the offline queue is lost when the app closes.

## Screens

With React Navigation, pass the helper to the container and every screen is
recorded under its route name:

```tsx
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native'
import { trackNavigation } from '@kissmyapps/react-native'

export function App() {
  const navigation = useNavigationContainerRef()
  return (
    <NavigationContainer ref={navigation} {...trackNavigation(navigation)}>
      …
    </NavigationContainer>
  )
}
```

Without React Navigation, call `KissMyApps.screen('Lesson')` when a screen
appears.

## Events and people

```ts
KissMyApps.track('lesson_completed', { lesson: 3 })
KissMyApps.identify('user-42', { email: 'amaka@example.com', plan: 'annual' })
KissMyApps.setTraits({ plan: 'monthly' })
KissMyApps.reset() // on sign out: the next events belong to a new person
KissMyApps.optOut() // stops sending, and remembers it across launches
KissMyApps.optIn()
await KissMyApps.flush()
```

Calls made before `init` are kept and run once it is called. Event names use
letters, numbers and `_ . : -`, start with a letter and are up to 80
characters; others are ignored.

## What it sends

- **Automatic events**: `session_started`, `app_installed` (first launch),
  `app_updated` (first launch of a new version or build), `app_opened` (with
  `from_background`), `app_backgrounded` (with `seconds_in_foreground`) and
  `screen_viewed`. Pass `trackLifecycle: false` to send only sessions,
  screens and your own events.
- **Person**: a random anonymous ID kept in storage, joined to your user ID
  after `identify`. There is no advertising ID.
- **Session**: a new one after 30 minutes in the background or without
  events (`sessionTimeoutMinutes`). While the app is open a heartbeat every
  minute keeps it counted as online.
- **Context**: iOS or Android and the OS version, phone or tablet, the
  device model on Android (iPhone or iPad on iOS), screen size, language,
  time zone, app version and the SDK version. Country, region and city are
  added by the server from the request; the IP address is only kept as a
  salted hash.
- **Delivery**: batched every 10 seconds (`flushIntervalSeconds`), at once
  when 30 events are waiting, and when the app goes to the background.
  While offline, events wait in storage (up to `maxQueue`, default 1000,
  oldest dropped first) and are retried with backoff, including on the next
  launch.

Options: `key` (required), `endpoint`, `appVersion`, `build`, `storage`,
`sessionTimeoutMinutes`, `flushIntervalSeconds`, `maxQueue`,
`trackLifecycle`, `debug` (logs failures to the console).

The request format is the same one every KissMyApps app SDK uses; see
`integrations/analytics-mobile/contract/app-events.json` in the KissMyApps
repository.
