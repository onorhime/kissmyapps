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
