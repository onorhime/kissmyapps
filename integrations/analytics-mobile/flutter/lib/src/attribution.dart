// The two attribution calls every KissMyApps app SDK makes: one install call on the first
// launch, and one open call for each link that opens the app later. What goes in them, and
// what comes back, is the `attribution` section of ../contract/app-events.json. Plain Dart,
// like the client.

import 'dart:async';
import 'dart:convert';

/// Where the install call goes, under the endpoint.
const String installPath = '/v1/attribution/install';

/// Where the open call goes, under the endpoint.
const String openPath = '/v1/attribution/open';

const int _maxUrl = 2048;
const int _maxParams = 10;
const int _maxReferrer = 1024;
const int _maxAppleAds = 4096;
final RegExp _deviceKey = RegExp(r'^[0-9a-f]{64}$');
final RegExp _clickId = RegExp(r'^[A-Za-z0-9_-]{16,40}$');

/// A deep link from KissMyApps, handed to `KissMyApps.onDeepLink` once.
class KissMyAppsDeepLink {
  /// A deep link with its [value], [params], whether it was [deferred], and the [url] that
  /// opened the app.
  const KissMyAppsDeepLink({
    required this.value,
    required this.params,
    required this.deferred,
    this.url,
  });

  /// The link's deep link value, such as `lesson`, or null when it has only parameters.
  final String? value;

  /// The deep link's parameters, such as `{'id': '4'}`.
  final Map<String, String> params;

  /// True when it came through an install (a deferred deep link), false when a link opened
  /// the app.
  final bool deferred;

  /// The link that opened the app, or null when the deep link came from the store install.
  final Uri? url;

  @override
  bool operator ==(Object other) =>
      other is KissMyAppsDeepLink &&
      other.value == value &&
      other.deferred == deferred &&
      other.url == url &&
      other.params.length == params.length &&
      params.entries.every((entry) => other.params[entry.key] == entry.value);

  @override
  int get hashCode => Object.hash(value, deferred, url, Object.hashAllUnordered(params.keys));

  @override
  String toString() =>
      'KissMyAppsDeepLink(value: $value, params: $params, deferred: $deferred, url: $url)';
}

/// What the plugin reads on the device for the attribution calls.
class KmaAttributionInfo {
  /// The device's attribution details; each may be missing.
  const KmaAttributionInfo({
    this.deviceKey,
    this.referrer,
    this.referrerClickTs,
    this.installBeginTs,
    this.appleAdsToken,
    this.clipboardClick,
    this.retryReferrer = false,
  });

  /// The details from the plugin's `attributionInfo` answer; anything of the wrong type is
  /// left out.
  factory KmaAttributionInfo.fromMap(Map<Object?, Object?> map) {
    String? text(String name) {
      final value = map[name];
      return value is String && value.isNotEmpty ? value : null;
    }

    int? whole(String name) {
      final value = map[name];
      return value is num ? value.toInt() : null;
    }

    return KmaAttributionInfo(
      deviceKey: text('deviceKey'),
      referrer: text('referrer'),
      referrerClickTs: whole('referrerClickTs'),
      installBeginTs: whole('installBeginTs'),
      appleAdsToken: text('appleAdsToken'),
      clipboardClick: text('clipboardClick'),
      retryReferrer: map['retryReferrer'] == true,
    );
  }

  /// The details as the plugin sends them, for saving.
  Map<String, Object?> toMap() => {
        if (deviceKey != null) 'deviceKey': deviceKey,
        if (referrer != null) 'referrer': referrer,
        if (referrerClickTs != null) 'referrerClickTs': referrerClickTs,
        if (installBeginTs != null) 'installBeginTs': installBeginTs,
        if (appleAdsToken != null) 'appleAdsToken': appleAdsToken,
        if (clipboardClick != null) 'clipboardClick': clipboardClick,
        if (retryReferrer) 'retryReferrer': true,
      };

  /// Lowercase hex SHA-256 of identifierForVendor (iOS) or ANDROID_ID (Android).
  final String? deviceKey;

  /// The Google Play install referrer (Android).
  final String? referrer;

  /// Seconds since 1970, from the Install Referrer API (Android).
  final int? referrerClickTs;

  /// Seconds since 1970, from the Install Referrer API (Android).
  final int? installBeginTs;

  /// AAAttribution.attributionToken() (iOS 14.3+).
  final String? appleAdsToken;

  /// The click ID after `kma:` on the clipboard, read only with clipboard handoff on (iOS).
  final String? clipboardClick;

  /// True when Google Play did not answer in time: the next try reads the referrer again.
  final bool retryReferrer;
}

/// Reads [KmaAttributionInfo] from the device: with [install], also the install referrer or
/// Apple Ads token; with [clipboard], a `kma:` click ID on the clipboard.
typedef KmaAttributionReader = Future<KmaAttributionInfo?> Function({
  required bool install,
  required bool clipboard,
});

/// The link as the SDK sends it: an https URL of at most 2,048 characters, or null.
String? httpsLink(Object? value) {
  if (value is! String) return null;
  final link = value.trim();
  if (link.isEmpty || link.length > _maxUrl) return null;
  final uri = Uri.tryParse(link);
  if (uri == null || !uri.isScheme('https') || uri.host.isEmpty || uri.userInfo.isNotEmpty) {
    return null;
  }
  return link;
}

/// The device key when it is one: 64 lowercase hex characters.
String? deviceKeyFrom(Object? value) =>
    value is String && _deviceKey.hasMatch(value) ? value : null;

String? _text(String? value, int max) =>
    value != null && value.isNotEmpty && value.length <= max ? value : null;

// Play answers 0 when it does not know.
int? _seconds(int? value) => value != null && value > 0 ? value : null;

String _iso(int milliseconds) =>
    DateTime.fromMillisecondsSinceEpoch(milliseconds, isUtc: true).toIso8601String();

/// The body of POST /v1/attribution/install.
Map<String, Object?> installBody({
  required String anonymousId,
  required String sessionId,
  required String platform,
  required int installedAt,
  required String sdk,
  required KmaAttributionInfo info,
  required bool clipboard,
  String? userId,
  String? appVersion,
  String? link,
}) {
  final body = <String, Object?>{
    'anonymous_id': anonymousId,
    'session_id': sessionId,
    'platform': platform,
    'installed_at': _iso(installedAt),
    'sdk': sdk,
  };
  if (userId != null && userId.isNotEmpty) body['user_id'] = userId;
  if (appVersion != null && appVersion.isNotEmpty) body['app_version'] = appVersion;
  final key = deviceKeyFrom(info.deviceKey);
  if (key != null) body['device_key'] = key;
  final url = httpsLink(link);
  if (url != null) body['link_url'] = url;
  if (platform == 'android') {
    // A longer referrer is cut to the contract's 1,024 characters.
    final raw = info.referrer;
    final referrer = raw == null || raw.isEmpty
        ? null
        : raw.substring(0, raw.length < _maxReferrer ? raw.length : _maxReferrer);
    final clicked = _seconds(info.referrerClickTs);
    final began = _seconds(info.installBeginTs);
    if (referrer != null) body['referrer'] = referrer;
    if (clicked != null) body['referrer_click_ts'] = clicked;
    if (began != null) body['install_begin_ts'] = began;
  } else {
    final appleAds = _text(info.appleAdsToken, _maxAppleAds);
    if (appleAds != null) body['apple_ads_token'] = appleAds;
    final click = info.clipboardClick?.trim();
    if (clipboard && click != null && _clickId.hasMatch(click)) body['clipboard_click'] = click;
  }
  return body;
}

/// The body of POST /v1/attribution/open.
Map<String, Object?> openBody({
  required String anonymousId,
  required String sessionId,
  required String platform,
  required String url,
  required int openedAt,
  required String sdk,
  String? userId,
  String? appVersion,
  String? deviceKey,
}) {
  final body = <String, Object?>{
    'anonymous_id': anonymousId,
    'session_id': sessionId,
    'platform': platform,
    'url': url,
    'opened_at': _iso(openedAt),
    'sdk': sdk,
  };
  if (userId != null && userId.isNotEmpty) body['user_id'] = userId;
  if (appVersion != null && appVersion.isNotEmpty) body['app_version'] = appVersion;
  final key = deviceKeyFrom(deviceKey);
  if (key != null) body['device_key'] = key;
  return body;
}

/// The deep link in an answer from either call, or null when it has none.
KissMyAppsDeepLink? deepLinkFrom(Object? answer, String? url) {
  if (answer is! Map) return null;
  final link = answer['deep_link'];
  if (link is! Map) return null;
  final value = link['value'];
  final params = link['params'];
  final clean = <String, String>{};
  if (params is Map) {
    for (final entry in params.entries) {
      if (clean.length >= _maxParams) break;
      // Text as it is; numbers and true/false as text; anything else is left out.
      final item = entry.value;
      if (item is String || item is num || item is bool) clean['${entry.key}'] = '$item';
    }
  }
  return KissMyAppsDeepLink(
    value: value is String ? value : null,
    params: clean,
    deferred: link['deferred'] == true,
    url: url == null ? null : Uri.tryParse(url),
  );
}

/// The answer's JSON, or null when it is not JSON.
Object? parseAnswer(String body) {
  try {
    return jsonDecode(body);
  } catch (_) {
    return null;
  }
}

/// Completes with the future's value, or with [fallback] after [limit] or when it fails.
Future<T> within<T>(Future<T> Function() start, Duration limit, T fallback) {
  final done = Completer<T>();
  final timer = Timer(limit, () {
    if (!done.isCompleted) done.complete(fallback);
  });
  void finish(T value) {
    timer.cancel();
    if (!done.isCompleted) done.complete(value);
  }

  try {
    start().then(finish, onError: (Object _) => finish(fallback));
  } catch (_) {
    finish(fallback);
  }
  return done.future;
}
