<p align="center">
  <a href="https://kissmyapps.dev">
    <img src=".github/assets/kissmyapps.svg" width="88" height="88" alt="KissMyApps">
  </a>
</p>

<h1 align="center">KissMyApps for iOS and Android</h1>

<p align="center">
  Installs, sessions, screens and your own events, from your app to your KissMyApps dashboard.<br>
  One line to start. Works offline. No advertising ID.
</p>

<p align="center">
  <a href="https://github.com/onorhime/kissmyapps-mobile/actions/workflows/ci.yml"><img src="https://github.com/onorhime/kissmyapps-mobile/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://jitpack.io/#onorhime/kissmyapps-mobile"><img src="https://jitpack.io/v/onorhime/kissmyapps-mobile.svg" alt="JitPack"></a>
  <img src="https://img.shields.io/badge/iOS-13%2B-ff80bf?logo=apple&logoColor=white&labelColor=222222" alt="iOS 13+">
  <img src="https://img.shields.io/badge/Android-5.0%2B-ff80bf?logo=android&logoColor=white&labelColor=222222" alt="Android 5.0+">
  <img src="https://img.shields.io/badge/Swift%20Package%20Manager-ready-ff80bf?logo=swift&logoColor=white&labelColor=222222" alt="Swift Package Manager">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff80bf?labelColor=222222" alt="MIT licence"></a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#track-what-matters">Track events</a> ·
  <a href="#attribution-and-deep-links">Attribution and deep links</a> ·
  <a href="#what-gets-recorded">What gets recorded</a> ·
  <a href="#options">Options</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#react-native-flutter-and-other-platforms">React Native and Flutter</a>
</p>

---

## Why this SDK

- **Start it and you are done.** Installs, updates, opens, time in the app, sessions and
  screens are recorded on their own. Add your own events when you want more.
- **Nothing is lost offline.** Events wait on the phone, survive a restart and go out with
  backoff once there is a connection.
- **Small and plain.** Pure Swift and Kotlin on top of Foundation and the Android SDK. On
  Android, Google's Play Install Referrer library is the one dependency. No code generation,
  no ProGuard rules.
- **Respectful by default.** A random ID per install, no advertising ID, no fingerprinting,
  and an opt-out that is remembered across launches.
- **One dashboard for every platform.** iOS, Android, React Native, Flutter and the web send
  the same events, so the dashboard compares them side by side.

## Requirements

|                 | iOS                           | Android                        |
| --------------- | ----------------------------- | ------------------------------ |
| Minimum version | iOS 13                        | Android 5.0 (API 21)           |
| Build tools     | Xcode 14 or later (Swift 5.7) | Gradle; Kotlin 1.9+ or Java 8+ |
| Languages       | Swift, SwiftUI or UIKit       | Kotlin or Java                 |
| Install from    | Swift Package Manager         | JitPack                        |
| Permissions     | None                          | `INTERNET`, added for you (1)  |

(1) Google's Play Install Referrer library adds the one permission it needs to ask the Play
Store which link brought the install. The SDK never asks for `AD_ID`.

You also need a **client key** from your project in the KissMyApps console, under
**Settings → API keys**. Keys starting `kma_pk_live_` count as production; keys starting
`kma_pk_test_` are kept apart as development, so your test runs never mix with real users.
The console's **Install SDK** page shows every step below with your key already filled in.

## Install

### iOS: Swift Package Manager

In Xcode, choose **File → Add Package Dependencies…**, paste the address below and add the
**KissMyApps** library to your app target.

```text
https://github.com/onorhime/kissmyapps-mobile
```

Or, in a `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/onorhime/kissmyapps-mobile", from: "1.1.0"),
],
targets: [
    .target(name: "MyApp", dependencies: [
        .product(name: "KissMyApps", package: "kissmyapps-mobile"),
    ]),
]
```

### Android: Gradle with JitPack

Add JitPack to your repositories, then the library to your app module.

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io")
    }
}
```

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("com.github.onorhime:kissmyapps-mobile:1.1.0")
}
```

<details>
<summary>Using Groovy build files</summary>

```groovy
// settings.gradle
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven { url 'https://jitpack.io' }
    }
}

// app/build.gradle
dependencies {
    implementation 'com.github.onorhime:kissmyapps-mobile:1.1.0'
}
```

</details>

## Quick start

Start the SDK once, as early as possible. That single call already records installs,
updates, opens, sessions and time in the app.

### iOS

```swift
import SwiftUI
import KissMyApps

@main
struct MyApp: App {
    init() {
        KissMyApps.start(key: "kma_pk_live_…")
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
```

<details>
<summary>Using UIKit</summary>

```swift
import UIKit
import KissMyApps

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        KissMyApps.start(key: "kma_pk_live_…")
        return true
    }
}
```

</details>

The app's version and build number are read from its `Info.plist`. When the app goes to
the background, the SDK asks iOS for a few seconds to send whatever is still queued.

### Android

```kotlin
import android.app.Application
import com.kissmyapps.KissMyApps

class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        KissMyApps.start(this, "kma_pk_live_…")
    }
}
```

Register the class in your manifest with `<application android:name=".MyApp" …>` if you do
not have one already.

<details>
<summary>Using Java</summary>

```java
import android.app.Application;
import com.kissmyapps.KissMyApps;

public class MyApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        KissMyApps.start(this, "kma_pk_live_…");
    }
}
```

Every method is static, so the rest reads the same: `KissMyApps.track("lesson_completed")`.

</details>

The app's version name and code are read from its package.

> [!TIP]
> Open your app once with a development key (`kma_pk_test_…`). Within a minute, **Check your
> setup** on the console's Install SDK page lists "iOS app (development)" or "Android app
> (development)".

## Track what matters

### Your own events

```swift
// iOS
KissMyApps.track("lesson_completed", properties: ["lesson": 3, "score": 0.92])
```

```kotlin
// Android
KissMyApps.track("lesson_completed", mapOf("lesson" to 3, "score" to 0.92))
```

Event names use letters, numbers and `_ . : -`, start with a letter and are up to 80
characters, such as `checkout_started` or `lesson:completed`. A name outside those rules is
ignored, with a warning when `debug` is on. Property values can be text, numbers, booleans,
dates, `nil`/`null`, lists and nested maps, up to 32 KB per event.

### Screens

```swift
// iOS, SwiftUI: recorded each time the view appears
LessonView()
    .kmaScreen("Lesson")

// iOS, UIKit or anywhere else
KissMyApps.screen("Lesson")
```

```kotlin
// Android, in an Activity or Fragment
override fun onResume() {
    super.onResume()
    KissMyApps.screen("Lesson")
}

// Android, Jetpack Compose
LaunchedEffect(Unit) { KissMyApps.screen("Lesson") }
```

Every `screen_viewed` event carries the screen's `name` and the `previous` one, and later
events carry the screen they happened on, so funnels and paths line up without extra work.

### People

```swift
// iOS
KissMyApps.identify("user-42", traits: ["email": "amaka@example.com", "plan": "annual"])
KissMyApps.setTraits(["plan": "monthly"])
KissMyApps.reset() // on sign out: what follows belongs to a new, anonymous person
```

```kotlin
// Android
KissMyApps.identify("user-42", mapOf("email" to "amaka@example.com", "plan" to "annual"))
KissMyApps.setTraits(mapOf("plan" to "monthly"))
KissMyApps.reset()
```

`identify` joins the anonymous history from before sign-in to your user ID, so a person's
first visit and their purchase show up as one journey.

### Everything at a glance

Apart from the SwiftUI modifier, every call is on `KissMyApps`, such as `KissMyApps.flush()`.

| iOS                     | Android                        | What it does                                          |
| ----------------------- | ------------------------------ | ----------------------------------------------------- |
| `start(key:options:)`   | `start(context, key, options)` | Starts recording. Call once.                          |
| `track(_:properties:)`  | `track(name, properties)`      | Records one of your events.                           |
| `screen(_:properties:)` | `screen(name, properties)`     | Records a screen view.                                |
| `View.kmaScreen(_:)`    | –                              | SwiftUI shortcut for `screen`.                        |
| `identify(_:traits:)`   | `identify(userId, traits)`     | Ties this install to your user ID.                    |
| `setTraits(_:)`         | `setTraits(traits)`            | Updates what you know about the person.               |
| `reset()`               | `reset()`                      | Forgets the person and starts a new anonymous one.    |
| `optOut()` / `optIn()`  | `optOut()` / `optIn()`         | Stops or resumes sending. Remembered across launches. |
| `flush()`               | `flush()`                      | Sends what is queued now.                             |
| `handleDeepLink(_:)`    | `handleDeepLink(intent)`       | Hands over the link that opened the app.              |
| `onDeepLink(_:)`        | `onDeepLink(listener)`         | Receives each deep link once, on the main thread.     |
| `anonymousId`           | `getAnonymousId()`             | This install's random ID, for support tickets.        |
| `sessionId`             | `getSessionId()`               | The current session's ID.                             |

Every call is safe from any thread and returns at once; the work happens on the SDK's own
serial queue. Calls made before `start` are kept and run as soon as it is called.

## Attribution and deep links

With attribution turned on for your project in the console, the SDK tells KissMyApps which
smart link brought each install, and hands your app the deep link that link carries: right
away when a link opens the app, or on the first launch after someone tapped a link, installed
the app and opened it (a deferred deep link). Until attribution is on, the calls do nothing.

### iOS

Installs need nothing from you: on the first launch, right after `app_installed`, the SDK
makes one call that KissMyApps matches to the link the person tapped. Links that open the
app need the steps below.

**1. Let your links open the app.** In the console, under **Attribution → Setup**, fill in
your app's App Store ID, Bundle ID and Team ID. Then in Xcode, open your app target's
**Signing & Capabilities**, add **Associated Domains** and enter your link domain (the
console shows it):

```text
applinks:<your-name>.go.kissmyapps.dev
```

Add an `applinks:` line for your own link domain too if you use one.

**2. Pass the links to the SDK.** In SwiftUI:

```swift
WindowGroup {
    ContentView()
        .onOpenURL { url in KissMyApps.handleDeepLink(url) }
}
```

<details>
<summary>Using a UIKit scene delegate</summary>

```swift
func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions
) {
    // The app was not running: the link that started it.
    if let url = connectionOptions.userActivities
        .first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb })?.webpageURL {
        KissMyApps.handleDeepLink(url)
    }
}

func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    if userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL {
        KissMyApps.handleDeepLink(url)
    }
}
```

Without scenes, do the same in your app delegate's
`application(_:continue:restorationHandler:)`.

</details>

`handleDeepLink` sends any `https` link to KissMyApps, which records the click when it is
one of your links. It returns `false` for anything else, such as your own URL scheme, so
you can route those yourself.

**3. Take people where the link points.** Set the callback once, right after `start`:

```swift
KissMyApps.onDeepLink { link in
    // link.value: "lesson", link.params: ["id": "4"], from the link's deep link in the console
    // link.deferred: true when the person installed the app first
    // link.url: the link that opened the app, or nil after an install from the App Store
    if link.value == "lesson", let id = link.params["id"] {
        router.openLesson(id)
    }
}
```

It runs on the main thread, once for each deep link. A deep link that arrives before you set
the callback waits for it. When the phone is offline the link cannot be looked up and the
callback is not called; route from the address you passed to `handleDeepLink` if you need a
fallback.

How an install is matched on iPhone, first match wins:

- **Reinstall**: the same iPhone installed the app before, within your reattribution window;
  it keeps the first install's source. iOS gives the phone a new `identifierForVendor` once
  the last of your apps is deleted, so a reinstall then counts as a new install.
- **The link opened the app** on its first launch: the SDK waits a moment (1.5 seconds) for
  the link and sends it with the install call. Later links, and links on later launches
  before the install call is answered, wait for that answer and then go on their own.
- **Apple Ads**: the SDK passes Apple's attribution token (iOS 14.3 and later) and
  KissMyApps asks Apple which campaign it was. No prompt and no advertising ID.
- **Clipboard handoff**, if you turn it on (below).
- **Sign-in**: the person signs in (`identify`) and had come to your website from a link.
- Otherwise the install counts as **organic**.

When the phone is offline on the first launch, the SDK tries again on up to three more
launches, once on each, with the first launch's details. While the person is opted out
nothing is sent; the install call goes when you call `optIn()`.

#### Clipboard handoff for iPhone (optional)

The App Store does not tell an app which link someone tapped before installing it. Clipboard
handoff fills that gap: on an iPhone, your link shows a small page whose **Get the app**
button copies a short code (`kma:` and the click) before it opens the App Store. On the
first launch the SDK reads the clipboard once and sends that code.

iOS shows the person that your app pasted from the clipboard, and from iOS 16 asks them to
allow it first. Turn it on only if that suits your app. It takes two switches:

1. In the console: **Attribution → Setup → Clipboard handoff for iPhone**.
2. In the app:

   ```swift
   KissMyApps.start(key: "kma_pk_live_…", options: KissMyAppsOptions(clipboardHandoff: true))
   ```

Without the option the SDK never reads the clipboard. With it, the clipboard is read only on
the first launch, only once, and only text starting with `kma:` is used; anything else is
left alone and never sent.

### Android

On the first launch, the SDK reads Google Play's install referrer once (the smart link puts
its click in it) and sends it with a device key: a SHA-256 of `Settings.Secure.ANDROID_ID`,
worked out on the phone. If the connection fails, it tries again on the next three launches.
No advertising ID is read.

**1. Let your links open the app.** In the console, under **Attribution → Android app**, enter
your package name and your app's SHA-256 signing certificate fingerprints. Google Play shows
them under **Setup → App signing**; add your upload key's too if you install builds you sign
yourself. Your link domain then serves `/.well-known/assetlinks.json` with them, which Android
checks before it opens your links in the app. A build signed with a key that is not listed
opens links in the browser.

**2. Add an App Links intent filter** to the activity links should open, with your link domain
from the console:

```xml
<!-- AndroidManifest.xml -->
<activity android:name=".MainActivity" android:exported="true">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="yourapp.go.kissmyapps.dev" />
    </intent-filter>
</activity>
```

**3. Hand the link to the SDK** in `onCreate` and `onNewIntent`, and **4. receive deep links**
with `onDeepLink`:

```kotlin
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import com.kissmyapps.KissMyApps

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Once per link: not again when the activity is recreated, such as after a rotation.
        if (savedInstanceState == null) KissMyApps.handleDeepLink(intent)
        KissMyApps.onDeepLink { deepLink ->
            // On the main thread, once per deep link.
            when (deepLink.value) {
                "lesson" -> openLesson(deepLink.params["id"])
            }
        }
    }

    // A link that opens the app while this activity is already running.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        KissMyApps.handleDeepLink(intent)
    }

    override fun onDestroy() {
        KissMyApps.onDeepLink(null)
        super.onDestroy()
    }
}
```

<details>
<summary>Using Java</summary>

```java
@Override
protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (savedInstanceState == null) KissMyApps.handleDeepLink(getIntent());
    KissMyApps.onDeepLink(deepLink -> {
        if ("lesson".equals(deepLink.getValue())) openLesson(deepLink.getParams().get("id"));
    });
}

@Override
protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    KissMyApps.handleDeepLink(intent);
}

@Override
protected void onDestroy() {
    KissMyApps.onDeepLink(null);
    super.onDestroy();
}
```

</details>

`handleDeepLink` returns `true` when the intent carries an https link, which the SDK sends;
KissMyApps decides whether it is one of your links. A link that opens the app on its first
launch goes with the install call, so it is counted once. A deep link that arrives before a
listener is set waits and goes to the first one you set.

| `DeepLink` | What it holds                                                               |
| ---------- | --------------------------------------------------------------------------- |
| `value`    | The link's deep link value, such as `lesson`, or `null`.                    |
| `params`   | The link's deep link parameters, such as `id` = `4`.                        |
| `deferred` | `true` when it came through an install, `false` when a link opened the app. |
| `url`      | The link that opened the app, or `null` when it came through Google Play.   |

To check that Android trusts your links (Android 12 and later):

```sh
adb shell pm verify-app-links --re-verify com.yourcompany.app
adb shell pm get-app-links com.yourcompany.app   # yourapp.go.kissmyapps.dev: verified
```

## What gets recorded

### Automatic events

| Event              | When                                       | Properties                                               |
| ------------------ | ------------------------------------------ | -------------------------------------------------------- |
| `session_started`  | A new session begins                       | –                                                        |
| `app_installed`    | The first launch after install             | `version`, `build`                                       |
| `app_updated`      | The first launch of a new version or build | `version`, `build`, `previous_version`, `previous_build` |
| `app_opened`       | The app comes to the foreground            | `from_background`                                        |
| `app_backgrounded` | The app leaves the foreground              | `seconds_in_foreground`                                  |
| `screen_viewed`    | You call `screen` or `.kmaScreen`          | `name`, `previous`, plus your own                        |

Set `trackLifecycle` to `false` to keep only sessions, screens and your own events.

A session ends after 30 minutes in the background or without events. While the app is
open, a light heartbeat every minute keeps the person counted as online in the dashboard.

### Context sent with every request

| Field                  | Example                             |
| ---------------------- | ----------------------------------- |
| Platform and OS        | `ios`, `iOS 18.1`                   |
| Device type and model  | `mobile`, `iPhone15,4` or `Pixel 7` |
| Screen size            | `393 × 852`                         |
| Language and time zone | `en-NG`, `Africa/Lagos`             |
| App version            | `2.4.0`                             |
| SDK version            | `kma-ios/1.1.0`                     |

Country, region and city are worked out by the KissMyApps server from the request's
address, which is only ever kept as a salted hash.

### Sent for install attribution

The install call on the first launch, and a call each time a link opens the app. Besides the
anonymous ID, the session, your user ID (after `identify`) and the app version:

| Field                 | When                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Device key            | Each call: the SHA-256 of `identifierForVendor` (iOS) or `ANDROID_ID` (Android), never the ID |
| Apple Ads attribution | iOS, the install call, iOS 14.3 and later, when iOS has one                                   |
| Clipboard click       | iOS, the install call, only with `clipboardHandoff` and a `kma:` code                         |
| Install referrer      | Android, the install call: Google Play's referrer and its two times                           |
| Opening link          | When a link opened the app                                                                    |

KissMyApps answers with the link's deep link. While attribution is off for the project, the
calls store nothing.

### Delivery and offline

```mermaid
flowchart LR
    A["track · screen · lifecycle"] --> Q[("Queue on disk<br/>up to 1,000 events")]
    Q -- "every 10 s, at 30 events,<br/>or going to the background" --> S["events.kissmyapps.dev"]
    S -- "no connection or server error" --> R["Retry with backoff,<br/>also on next launch"]
    R --> Q
```

- Each event is written to the app's own storage as soon as it is recorded, so a crash, a
  force quit or a dead network does not lose it.
- When the queue is full, the oldest events are dropped first.
- A request the server refuses outright (a 4xx, such as a revoked key) is dropped instead
  of retried forever; turn on `debug` to see why.

## Options

Pass options as the last argument to `start`. Every option has a default.

```swift
// iOS
KissMyApps.start(key: "kma_pk_live_…", options: KissMyAppsOptions(
    sessionTimeoutMinutes: 15,
    debug: true
))
```

```kotlin
// Android
KissMyApps.start(this, "kma_pk_live_…", KissMyAppsOptions(
    sessionTimeoutMinutes = 15,
    debug = BuildConfig.DEBUG,
))
```

| Option                  | Default                          | What it does                                                          |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------- |
| `appVersion`            | From `Info.plist` or the package | The version shown in the dashboard.                                   |
| `build`                 | From `Info.plist` or the package | The build number, used to spot updates.                               |
| `endpoint`              | `https://events.kissmyapps.dev`  | Where events are sent.                                                |
| `sessionTimeoutMinutes` | `30`                             | Minutes in the background or idle before a new session starts.        |
| `flushIntervalSeconds`  | `10`                             | How often queued events are sent while the app is open.               |
| `maxQueue`              | `1000`                           | The most events kept while offline.                                   |
| `trackLifecycle`        | `true`                           | Record installs, updates, opens and backgrounding.                    |
| `debug`                 | `false`                          | Log refused events and other problems to the Xcode console or Logcat. |
| `clipboardHandoff`      | `false`                          | iOS: read the clipboard once on the first launch, see above.          |

## Privacy

- **Per-install ID only.** The anonymous ID is random, stored in the app's own storage and
  left out of device backups, so a restored phone counts as a new install. Nothing is shared
  with other apps.
- **No advertising identifiers.** The SDK never reads the IDFA or the Android advertising
  ID, and never asks for App Tracking Transparency.
- **Attribution without tracking (Android).** The install call sends Google Play's install
  referrer and a device key: a SHA-256 of `ANDROID_ID`, which Android already scopes to your
  app's signing key. The ID itself never leaves the phone. In the Google Play Data safety
  form, that is "Device or other IDs", used for analytics.
- **No fingerprinting and no raw addresses.** The server turns the request's IP address into
  a country, region and city, then keeps only a salted hash of it.
- **Consent is one call.** `optOut()` stops all sending and clears the queue until
  `optIn()`, and the choice survives app restarts.
- **You decide what is personal.** Only the traits and properties you pass are sent; leave
  out anything you would not want in your dashboard.

When you fill in the App Store privacy details or the Google Play Data safety form, the
lists under [What gets recorded](#what-gets-recorded) are everything this SDK sends.

On iOS, install attribution uses the SHA-256 of `identifierForVendor` (the ID itself never
leaves the phone) and Apple Ads' attribution token, which needs no prompt. The iOS package
includes a privacy manifest (`PrivacyInfo.xcprivacy`), which Xcode adds to your app's
privacy report: no tracking and no tracking domains; it collects a device ID, product
interaction and coarse location (the country, region and city the server works out from the
address); and it uses none of the APIs Apple asks a reason for. The manifest says the data
is not linked to the person, which is true until you call `identify`: if you do, answer
"linked to the user" for that data in App Store Connect.

## React Native, Flutter and other platforms

- **React Native and Expo:** [`@kissmyappss/react-native`](https://www.npmjs.com/package/@kissmyappss/react-native),
  plain JavaScript with no native code to link.
- **Flutter:** [`kissmyapps`](https://pub.dev/packages/kissmyapps) on pub.dev, for Android
  and iOS, with a navigator observer for screens. Its source is in [`flutter/`](flutter).
- **Websites:** the console's Install SDK page has the one-line script tag.
- **Anything else:** send the same JSON over HTTP; the format is in
  [`contract/app-events.json`](contract/app-events.json).

## How it is built

Each platform has a small, platform-free core (`Client` in [`ios/Sources`](ios/Sources/KissMyApps),
`KmaClient` in [`android/core`](android/core) and in
[`flutter/lib/src`](flutter/lib/src/client.dart)) that holds every rule: sessions, the queue,
retries and the request format. Storage, HTTP, the clock and the device are passed in, so
the tests drive the core with a clock they control and check every request against
[`contract/app-events.json`](contract/app-events.json), the same file the server's tests use.

```sh
swift test                                   # iOS core, on macOS or Linux
cd android && ./gradlew -p core test         # Android core, on any JVM
cd android && ./gradlew :kissmyapps:assembleRelease
cd flutter && flutter test                   # Flutter, on any machine with Flutter
```

Set `KMA_CONTRACT_ENDPOINT` and `KMA_CONTRACT_KEY` to also run a test that sends a real launch
to a KissMyApps ingest and checks every event arrived.

```text
.
├── Package.swift          Swift package manifest
├── ios/                   Swift sources and tests
├── android/
│   ├── core/              Kotlin core and its JVM tests
│   └── kissmyapps/        The Android library JitPack builds
├── flutter/               The Flutter package published to pub.dev
├── contract/              The request format every SDK is tested against
└── jitpack.yml
```

## Versioning

Releases follow [semantic versioning](https://semver.org) and are tagged here, which is
where both Swift Package Manager and JitPack read them. See [CHANGELOG.md](CHANGELOG.md) for
what changed.

## License

[MIT](LICENSE) © KissMyApps
