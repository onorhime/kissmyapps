# KissMyApps example

A two-screen app that starts the SDK, records each page with `KissMyAppsObserver` and sends
an event from a button.

```sh
cd example
flutter create --platforms=android,ios .
flutter run --dart-define=KMA_KEY=kma_pk_test_…
```

Use a test key from your project's **Settings → API keys** so the events stay apart from
production.
