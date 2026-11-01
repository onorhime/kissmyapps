<p align="center">
  <a href="https://kissmyapps.dev">
    <img src="https://raw.githubusercontent.com/onorhime/kissmyapps-mobile/main/.github/assets/kissmyapps.png" width="88" height="88" alt="KissMyApps">
  </a>
</p>

<h1 align="center">KissMyApps for Flutter</h1>

<p align="center">
  Installs, sessions, screens and your own events, from your Flutter app to your KissMyApps dashboard.<br>
  One package, no other dependencies, Android and iOS.
</p>

<p align="center">
  <a href="https://pub.dev/packages/kissmyapps"><img src="https://img.shields.io/pub/v/kissmyapps?color=ff80bf&labelColor=222222" alt="pub.dev"></a>
  <img src="https://img.shields.io/badge/Flutter-3.24%2B-ff80bf?logo=flutter&logoColor=white&labelColor=222222" alt="Flutter 3.24+">
  <img src="https://img.shields.io/badge/Android-5.0%2B-ff80bf?logo=android&logoColor=white&labelColor=222222" alt="Android 5.0+">
  <img src="https://img.shields.io/badge/iOS-12%2B-ff80bf?logo=apple&logoColor=white&labelColor=222222" alt="iOS 12+">
  <img src="https://img.shields.io/badge/license-MIT-ff80bf?labelColor=222222" alt="MIT licence">
</p>

---

## Why this SDK

- **Start it and you are done.** Installs, updates, opens, time in the app and sessions are
  recorded on their own; every page of your app takes one line.
- **Nothing is lost offline.** Events wait on disk, survive a restart and go out with
  backoff once there is a connection. On iOS the app is given time to send when it leaves
  the screen.
- **Nothing else to install.** No dependencies besides Flutter, and a tiny native part that
  reads the device model, time zone and app version.
- **Respectful by default.** A random ID per install, no advertising ID, no fingerprinting,
  and an opt-out that is remembered across launches.
- **One dashboard for every platform.** It sends the same events as the
  [iOS, Android](https://github.com/onorhime/kissmyapps-mobile) and
  [React Native](https://www.npmjs.com/package/@kissmyappss/react-native) SDKs and the web
  script.

## Install

```sh
flutter pub add kissmyapps
```

You need Flutter 3.24 or later, and a **client key** from your project in the KissMyApps
console under **Settings → API keys**. Keys starting `kma_pk_live_` count as production;
keys starting `kma_pk_test_` are kept apart as development.

There is nothing to add to `Info.plist` or `AndroidManifest.xml`: the package brings the
internet permission with it, and reads the app's version and build number by itself.

## Quick start

Start the SDK once, as early as possible, and add the observer to your app:

```dart
import 'package:flutter/material.dart';
import 'package:kissmyapps/kissmyapps.dart';

void main() {
  KissMyApps.start('kma_pk_live_…');
  runApp(const App());
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorObservers: [KissMyAppsObserver()],
      routes: {
        '/': (_) => const HomeScreen(),
        '/lesson': (_) => const LessonScreen(),
      },
    );
  }
}
```

There is no need to `await` `start`: calls made while it starts are kept and sent once it
has.

## Track what matters

### Screens

`KissMyAppsObserver` records a screen view each time a page comes to the front, under its
route name. Dialogs, bottom sheets and menus are left out.

<details>
<summary>With go_router</summary>

```dart
final router = GoRouter(
  observers: [KissMyAppsObserver()],
  routes: [
    GoRoute(path: '/', name: 'Home', builder: (_, __) => const HomeScreen()),
    GoRoute(path: '/lesson/:id', name: 'Lesson', builder: (_, state) => LessonScreen(state)),
  ],
);
```

Pages are recorded under the route's `name`, or its path when it has none. Routes inside a
`ShellRoute` live in their own navigator: give the shell its own observer,
`ShellRoute(observers: [KissMyAppsObserver()], …)`.

</details>

<details>
<summary>Pages pushed without a name</summary>

A `MaterialPageRoute` pushed with `Navigator.push` has no name unless you give it one:

```dart
Navigator.push(
  context,
  MaterialPageRoute(
    settings: const RouteSettings(name: 'Lesson'),
    builder: (_) => const LessonScreen(),
  ),
);
```

Or name screens your own way:

```dart
KissMyAppsObserver(
  nameExtractor: (settings) => switch (settings.name) {
    '/' => 'Home',
    final name => name,
  },
)
```

</details>

Without a navigator, call `KissMyApps.screen('Lesson')` when a screen appears.

### Events and people

```dart
KissMyApps.track('lesson_completed', properties: {'lesson': 3, 'score': 0.92});

KissMyApps.identify('user-42', traits: {'email': 'amaka@example.com', 'plan': 'annual'});
KissMyApps.setTraits({'plan': 'monthly'});
KissMyApps.reset(); // on sign out: what follows belongs to a new, anonymous person

KissMyApps.optOut(); // stops sending, remembered across launches
KissMyApps.optIn();
await KissMyApps.flush();
```

Event names use letters, numbers and `_ . : -`, start with a letter and are up to 80
characters; other names are ignored. Properties are plain JSON: numbers, text, booleans,
lists and maps, with `DateTime` values sent as ISO 8601 text and enums by name.

### Everything at a glance

| Call                                   | What it does                                          |
| -------------------------------------- | ----------------------------------------------------- |
| `KissMyApps.start(key, options:)`      | Starts recording. Call once.                          |
| `KissMyApps.track(name, properties:)`  | Records one of your events.                           |
| `KissMyApps.screen(name, properties:)` | Records a screen view.                                |
| `KissMyAppsObserver()`                 | Records every page of a navigator.                    |
| `KissMyApps.identify(id, traits:)`     | Ties this install to your user ID.                    |
| `KissMyApps.setTraits(traits)`         | Updates what you know about the person.               |
| `KissMyApps.reset()`                   | Forgets the person and starts a new anonymous one.    |
| `KissMyApps.optOut()` / `optIn()`      | Stops or resumes sending. Remembered across launches. |
| `KissMyApps.flush()`                   | Sends what is queued now; returns a future.           |
| `KissMyApps.anonymousId`               | This install's random ID, for support tickets.        |
| `KissMyApps.sessionId`                 | The current session's ID.                             |

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
model (such as `iPhone15,4` or `Pixel 8`), screen size, language, time zone, app version
and the SDK version. Country, region and city are worked out by the KissMyApps server from
the request's address, which is only ever kept as a salted hash. There is no advertising
ID.

A session ends after 30 minutes in the background or without events. Events are sent every
10 seconds, at once when 30 are waiting, and when the app goes to the background. While
offline they wait on disk (up to 1,000, oldest dropped first) and are retried with backoff,
including on the next launch. The files are left out of phone backups, so a restored phone
counts as a new install.

## Options

```dart
KissMyApps.start(
  'kma_pk_live_…',
  options: const KissMyAppsOptions(sessionTimeoutMinutes: 15, debug: true),
);
```

| Option                  | Default                         | What it does                                                   |
| ----------------------- | ------------------------------- | -------------------------------------------------------------- |
| `appVersion`            | From the app                    | The version shown in the dashboard.                            |
| `build`                 | From the app                    | The build number, used to spot updates.                        |
| `endpoint`              | `https://events.kissmyapps.dev` | Where events are sent.                                         |
| `sessionTimeoutMinutes` | `30`                            | Minutes in the background or idle before a new session starts. |
| `flushIntervalSeconds`  | `10`                            | How often queued events are sent while the app is open.        |
| `maxQueue`              | `1000`                          | The most events kept while offline.                            |
| `trackLifecycle`        | `true`                          | Record installs, updates, opens and backgrounding.             |
| `debug`                 | `false`                         | Print refused events and other problems to the console.        |

## Web, desktop and tests

The SDK records on Android and iOS. On the web, macOS, Windows and Linux every call does
nothing, so an app that builds for those too needs no special case. Widget tests have no
native side, so the SDK records nothing there; leave `start` out of them, or call it
without `await`.

## License

MIT © KissMyApps
