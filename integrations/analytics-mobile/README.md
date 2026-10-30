# KissMyApps for iOS and Android

Sends what people do in your app to your KissMyApps project: installs,
updates, opens, sessions, screens and your own events. The React Native SDK
lives next door in `integrations/analytics-react-native`.

- **iOS 13+**: a Swift package (`Package.swift`, sources in `ios/`).
- **Android 5.0+ (API 21)**: a Kotlin library built by JitPack (`android/`).

Both start with the project's client key from **Settings > API keys** in the
console. The console's **Install SDK** page shows these steps with the key
filled in.

## iOS

In Xcode, choose **File > Add Package Dependencies** and paste
`https://github.com/onorhime/kissmyapps-mobile`.

```swift
import KissMyApps

@main
struct MyApp: App {
    init() {
        KissMyApps.start(key: "kma_pk_live_…")
    }
    var body: some Scene { WindowGroup { ContentView() } }
}

KissMyApps.identify("user-42", traits: ["email": "amaka@example.com", "plan": "annual"])
KissMyApps.track("lesson_completed", properties: ["lesson": 3])
KissMyApps.screen("Lesson") // or LessonView().kmaScreen("Lesson") in SwiftUI
KissMyApps.reset()          // on sign out
KissMyApps.optOut()         // remembered across launches; optIn() undoes it
```

With UIKit, call `start` in `application(_:didFinishLaunchingWithOptions:)`.
The app's version and build come from its Info.plist. When the app goes to
the background the SDK asks iOS for a few seconds to send what is queued.

## Android

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io")
    }
}

// app/build.gradle.kts
dependencies {
    implementation("com.github.onorhime:kissmyapps-mobile:1.0.0")
}
```

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        KissMyApps.start(this, "kma_pk_live_…")
    }
}

KissMyApps.identify("user-42", mapOf("email" to "amaka@example.com", "plan" to "annual"))
KissMyApps.track("lesson_completed", mapOf("lesson" to 3))
KissMyApps.screen("Lesson")
KissMyApps.reset()
```

Every method is also callable from Java (`KissMyApps.track("…")`). The app's
version name and code come from its package. The library adds the `INTERNET`
permission and nothing else, and needs no ProGuard rules.

## What both send

- **Automatic events**: `session_started`, `app_installed` (first launch),
  `app_updated` (first launch of a new version or build), `app_opened` (with
  `from_background`), `app_backgrounded` (with `seconds_in_foreground`) and
  `screen_viewed`. `KissMyAppsOptions(trackLifecycle = false)` sends only
  sessions, screens and your own events.
- **Person**: a random anonymous ID kept in the app's own storage (left out
  of backups, so a restored phone counts as a new install), joined to your
  user ID after `identify`. There is no advertising ID.
- **Session**: a new one after 30 minutes in the background or without
  events. While the app is open, a heartbeat every minute keeps it counted as
  online.
- **Context**: OS and version, phone or tablet, the device model (such as
  `iPhone15,4` or `Pixel 7`), screen size, language, time zone, app version
  and SDK version. Country, region and city are added by the server from the
  request; the IP address is only kept as a salted hash.
- **Delivery**: batched every 10 seconds, at once when 30 events are waiting,
  and when the app goes to the background. While offline, events wait on
  disk (up to 1,000, oldest dropped first) and are retried with backoff,
  including on the next launch. A request the server refuses (4xx) is
  dropped; anything else is retried.

Options (`KissMyAppsOptions`): `appVersion`, `build`, `endpoint`,
`sessionTimeoutMinutes`, `flushIntervalSeconds`, `maxQueue`,
`trackLifecycle`, `debug`.

## How it is built and tested

The rules live in a platform-free core in each language, `KmaClient` in
`android/core` and `Client` in `ios/Sources`, with the platform (storage,
HTTP, a serial thread or queue, the device and the clock) passed in. The
tests drive each core with a clock they control and check every request
against `contract/app-events.json`, the same file the React Native tests and
the ingest function's tests use.

```sh
cd android && ./gradlew -p core test   # the Android core, on any JVM
cd android && ./gradlew :kissmyapps:assembleRelease
swift test                              # the iOS core, on macOS or Linux
```

Both suites also have a test that sends a real launch to a running ingest and
checks it stored all six events; it runs when `KMA_CONTRACT_ENDPOINT` and
`KMA_CONTRACT_KEY` are set.

## Releasing

Swift Package Manager and JitPack both need `Package.swift` and `jitpack.yml`
at the root of a public repository, so this folder is published as its own
repository (by default `onorhime/kissmyapps-mobile`; the console reads the
address from `MOBILE_SDK` in `src/merchant/config.ts`):

```sh
git subtree split --prefix integrations/analytics-mobile -b mobile-sdk
git push https://github.com/onorhime/kissmyapps-mobile.git mobile-sdk:main
# then tag the release there, for example 1.0.0, and open
# https://jitpack.io/#onorhime/kissmyapps-mobile/1.0.0 once to start the first build
```
