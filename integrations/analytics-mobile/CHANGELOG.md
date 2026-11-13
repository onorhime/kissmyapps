# Changelog

All notable changes to the KissMyApps iOS and Android SDKs. Releases follow
[semantic versioning](https://semver.org).

## 1.1.0 (unreleased)

Install attribution, deep links and revenue.

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
- `KissMyApps.revenue(_:currency:productId:transactionId:event:properties:)` records a
  payment, with the amount as a `Decimal` in major units (negative for a refund), as a
  `purchase` (or `refund`) event with the reserved properties `kma_revenue`,
  `kma_currency`, `kma_product_id` and `kma_transaction_id`. A transaction ID makes the
  app's call and a RevenueCat or Adapty webhook for the same payment count once. An amount
  that is 0 or over 1,000,000,000 either way, or a currency that is not three letters,
  sends nothing.

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
- `KissMyApps.revenue(amount, currency, productId, transactionId, event, properties)`
  records a payment in major units (negative for a refund) as a `purchase` (or `refund`)
  event with the reserved properties `kma_revenue`, `kma_currency`, `kma_product_id` and
  `kma_transaction_id`; every parameter after `currency` is optional, with overloads for
  Java. A transaction ID makes the app's call and a RevenueCat or Adapty webhook for the
  same payment count once. An amount that is 0 or over 1,000,000,000 either way, or a
  currency that is not three letters, sends nothing.

## 1.0.0 (2026-10-30)

The first release.

- iOS 13+ Swift package and Android 5.0+ (API 21) library, installed with Swift Package
  Manager and JitPack.
- Automatic `session_started`, `app_installed`, `app_updated`, `app_opened`,
  `app_backgrounded` and `screen_viewed` events.
- `track`, `screen`, `identify`, `setTraits`, `reset`, `optOut`, `optIn` and `flush`, plus
  the SwiftUI `.kmaScreen` modifier.
- An offline queue on disk (up to 1,000 events) with batching and retries with backoff.
