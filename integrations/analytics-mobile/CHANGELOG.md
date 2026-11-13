# Changelog

All notable changes to the KissMyApps iOS and Android SDKs. Releases follow
[semantic versioning](https://semver.org).

## 1.1.0 (unreleased)

Install attribution and deep links.

### iOS

- On the first launch, right after `app_installed`, one call to `/v1/attribution/install`
  with the SHA-256 of `identifierForVendor`, the Apple Ads attribution token (iOS 14.3+),
  the link that opened the app, and, only with the new `clipboardHandoff` option, a `kma:`
  click from the clipboard. Offline, it tries again on up to three more launches.
- `KissMyApps.handleDeepLink(_:)` for the links that open the app (SwiftUI `.onOpenURL`,
  UIKit `scene(_:continue:)`), and `KissMyApps.onDeepLink { link in }` with the link's
  `value`, `params`, `deferred` and `url`. A deep link that arrives before the callback is
  set waits for it, and each is given once.
- A privacy manifest, `PrivacyInfo.xcprivacy`: no tracking, no tracking domains, no
  required-reason APIs.
- Still no IDFA and no prompts. Events now go out right before the install call on the
  first launch, instead of up to 10 seconds later.

## 1.0.0 (2026-10-30)

The first release.

- iOS 13+ Swift package and Android 5.0+ (API 21) library, installed with Swift Package
  Manager and JitPack.
- Automatic `session_started`, `app_installed`, `app_updated`, `app_opened`,
  `app_backgrounded` and `screen_viewed` events.
- `track`, `screen`, `identify`, `setTraits`, `reset`, `optOut`, `optIn` and `flush`, plus
  the SwiftUI `.kmaScreen` modifier.
- An offline queue on disk (up to 1,000 events) with batching and retries with backoff.
