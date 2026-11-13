# Changelog

All notable changes to `@kissmyappss/react-native`. Releases follow
[semantic versioning](https://semver.org).

## 1.1.0

Install attribution and deep links.

- On the first launch, right after `app_installed`, the SDK calls `/v1/attribution/install`
  once to match the install to the smart link that brought it. Offline, it tries again on the
  next three launches with the same details.
- Links that open the app are read from `Linking` (`getInitialURL()` and `url` events) and
  reported to `/v1/attribution/open`. The first launch's opening link goes with the install
  call instead.
- `KissMyApps.onDeepLink(handler)` receives the deferred deep link after an install and the
  deep link of each link that opens the app, once each; one that arrives before a handler is
  set waits for it.
- `KissMyApps.handleDeepLink(url)` reports a link that reached the app another way.
- New options `attribution`, `deepLinks` and `clipboardHandoff`.
- An optional native module, `KissMyAppsAttribution` (Swift and Kotlin, linked by
  autolinking), adds the device key (a SHA-256 hash of `identifierForVendor` or `ANDROID_ID`),
  the Google Play install referrer, the Apple Ads token and the iPhone clipboard handoff.
  Without it, as in Expo Go, the install call runs without those fields. The iOS pod brings a
  privacy manifest.
- The SDK string is now `kma-react-native/1.1.0`.

## 1.0.0 (2026-10-30)

The first release.

- Automatic `session_started`, `app_installed`, `app_updated`, `app_opened`,
  `app_backgrounded` and `screen_viewed` events, with screens from React Navigation.
- `track`, `screen`, `identify`, `setTraits`, `reset`, `optOut`, `optIn` and `flush`.
- An offline queue in AsyncStorage (up to 1,000 events) with batching and retries with
  backoff.
