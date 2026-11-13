# Changelog

All notable changes to the KissMyApps iOS and Android SDKs. Releases follow
[semantic versioning](https://semver.org).

## 1.1.0 (unreleased)

### Android

- Install attribution: on the first launch the SDK reads Google Play's install referrer once,
  through Google's Play Install Referrer library 2.2 (the SDK's one dependency), and calls
  `/v1/attribution/install` with it and a device key, a SHA-256 of `ANDROID_ID` worked out on
  the phone. A call lost to a bad connection is tried again on the next three launches.
- Deep links: `KissMyApps.handleDeepLink(intent)` for the activity your App Links open, and
  `KissMyApps.onDeepLink { deepLink -> }`, which receives each deep link once on the main
  thread, including the deferred one an install brought. A deep link that arrives before a
  listener is set waits for one.
- No advertising ID and no `AD_ID` permission. The only new permission is the one the
  install referrer library declares.

## 1.0.0 (2026-10-30)

The first release.

- iOS 13+ Swift package and Android 5.0+ (API 21) library, installed with Swift Package
  Manager and JitPack.
- Automatic `session_started`, `app_installed`, `app_updated`, `app_opened`,
  `app_backgrounded` and `screen_viewed` events.
- `track`, `screen`, `identify`, `setTraits`, `reset`, `optOut`, `optIn` and `flush`, plus
  the SwiftUI `.kmaScreen` modifier.
- An offline queue on disk (up to 1,000 events) with batching and retries with backoff.
