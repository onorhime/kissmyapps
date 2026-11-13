## 1.1.0

Install attribution, deep links and revenue.

- On the first launch, right after `app_installed`, the SDK calls `/v1/attribution/install`
  once to match the install to the smart link that brought it. Offline, it tries again on the
  next three launches with the same details.
- Links that open the app are reported to `/v1/attribution/open`; the first launch's opening
  link goes with the install call instead.
- `KissMyApps.onDeepLink(handler)` receives the deferred deep link after an install and the
  deep link of each link that opens the app, once each, as a `KissMyAppsDeepLink`; one that
  arrives before a handler is set waits for it.
- `KissMyApps.handleDeepLink(uri)` reports a link that reached the app another way.
- New options `attribution`, `deepLinks` and `clipboardHandoff`.
- The plugin's new `attributionInfo` and `initialLink` methods and `kissmyapps/links` event
  channel: the device key (a SHA-256 hash of `identifierForVendor` or `ANDROID_ID`), the
  Google Play install referrer (Install Referrer 2.2), the Apple Ads token, the iPhone
  clipboard handoff, and the App Links and Universal Links that open the app.
- The iOS plugin brings a privacy manifest.
- `KissMyApps.revenue(amount, currency, productId:, transactionId:, event:, properties:)`
  records a payment in major units (negative for a refund) as a `purchase` (or `refund`)
  event with the reserved properties `kma_revenue`, `kma_currency`, `kma_product_id` and
  `kma_transaction_id`. A transaction ID makes the app's call and a RevenueCat or Adapty
  webhook for the same payment count once. An amount that is 0 or over 1,000,000,000
  either way, or a currency that is not three letters, sends nothing.
- The SDK string is now `kma-flutter/1.1.0`.

## 1.0.0

The first release.

- Android 5.0+ (API 21) and iOS 12+. On other platforms the SDK does nothing, so apps that
  also build for the web or desktop keep working.
- Automatic `session_started`, `app_installed`, `app_updated`, `app_opened`,
  `app_backgrounded` and `screen_viewed` events.
- `KissMyAppsObserver` records each page of a `Navigator`, `MaterialApp` or go_router.
- `track`, `screen`, `identify`, `setTraits`, `reset`, `optOut`, `optIn` and `flush`.
- An offline queue on disk (up to 1,000 events) with batching and retries with backoff.
- No dependencies besides Flutter.
