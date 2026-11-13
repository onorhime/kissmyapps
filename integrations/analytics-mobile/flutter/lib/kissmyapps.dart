/// KissMyApps analytics for Flutter apps on Android and iOS: installs, updates, opens,
/// sessions, screens and your own events, sent to your KissMyApps dashboard, plus install
/// attribution and deep links from smart links.
///
/// ```dart
/// void main() {
///   KissMyApps.start('kma_pk_live_…');
///   KissMyApps.onDeepLink((link) => print('Open ${link.value} ${link.params}'));
///   runApp(const App());
/// }
/// ```
library;

export 'src/attribution.dart' show KissMyAppsDeepLink;
export 'src/client.dart' show sdkVersion;
export 'src/kissmyapps.dart' show KissMyApps;
export 'src/observer.dart' show KissMyAppsObserver;
export 'src/options.dart' show KissMyAppsOptions, defaultEndpoint;
