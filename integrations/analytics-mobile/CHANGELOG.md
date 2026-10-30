# Changelog

All notable changes to the KissMyApps iOS and Android SDKs. Releases follow
[semantic versioning](https://semver.org).

## 1.0.0 (2026-10-30)

The first release.

- iOS 13+ Swift package and Android 5.0+ (API 21) library, installed with Swift Package
  Manager and JitPack.
- Automatic `session_started`, `app_installed`, `app_updated`, `app_opened`,
  `app_backgrounded` and `screen_viewed` events.
- `track`, `screen`, `identify`, `setTraits`, `reset`, `optOut`, `optIn` and `flush`, plus
  the SwiftUI `.kmaScreen` modifier.
- An offline queue on disk (up to 1,000 events) with batching and retries with backoff.
