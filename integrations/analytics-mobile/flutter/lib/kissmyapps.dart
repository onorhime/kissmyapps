/// KissMyApps analytics for Flutter apps on Android and iOS: installs, updates, opens,
/// sessions, screens and your own events, sent to your KissMyApps dashboard.
///
/// ```dart
/// void main() {
///   KissMyApps.start('kma_pk_live_…');
///   runApp(const App());
/// }
/// ```
library;

export 'src/client.dart' show sdkVersion;
export 'src/kissmyapps.dart' show KissMyApps;
export 'src/observer.dart' show KissMyAppsObserver;
export 'src/options.dart' show KissMyAppsOptions, defaultEndpoint;
