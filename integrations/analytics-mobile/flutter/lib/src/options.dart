/// Where events go unless [KissMyAppsOptions.endpoint] says otherwise.
const String defaultEndpoint = 'https://events.kissmyapps.dev';

/// Settings for `KissMyApps.start`. Every one has a default.
class KissMyAppsOptions {
  /// Settings for `KissMyApps.start`; leave out any you do not need.
  const KissMyAppsOptions({
    this.appVersion,
    this.build,
    this.endpoint = defaultEndpoint,
    this.sessionTimeoutMinutes = 30,
    this.flushIntervalSeconds = 10,
    this.maxQueue = 1000,
    this.trackLifecycle = true,
    this.debug = false,
  });

  /// The version shown in the dashboard, such as 2.4.0. Read from the app when left out.
  final String? appVersion;

  /// The build number, such as 120, used to spot updates. Read from the app when left out.
  final String? build;

  /// Where events are sent.
  final String endpoint;

  /// Minutes in the background or without events before a new session starts.
  final int sessionTimeoutMinutes;

  /// How often queued events are sent while the app is open.
  final int flushIntervalSeconds;

  /// The most events kept while offline; the oldest go first.
  final int maxQueue;

  /// Record installs, updates, opens and backgrounding.
  final bool trackLifecycle;

  /// Print refused events and other problems to the console.
  final bool debug;

  /// These options, with the app's version and build filled in where they were left out.
  KissMyAppsOptions withVersion(String? version, String? buildNumber) {
    return KissMyAppsOptions(
      appVersion: appVersion ?? version,
      build: build ?? buildNumber,
      endpoint: endpoint,
      sessionTimeoutMinutes: sessionTimeoutMinutes,
      flushIntervalSeconds: flushIntervalSeconds,
      maxQueue: maxQueue,
      trackLifecycle: trackLifecycle,
      debug: debug,
    );
  }
}
