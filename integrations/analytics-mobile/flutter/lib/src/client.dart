// The KissMyApps app client in plain Dart, with no Flutter in it: storage, the device, the
// network and the clock come in through KmaEnvironment, so the same code runs in tests. It
// follows the same rules as the iOS, Android and React Native SDKs; what it sends is checked
// against ../contract/app-events.json.

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'options.dart';

/// The version of this SDK, sent with every request as `kma-flutter/<version>`.
const String sdkVersion = '1.0.0';

/// The names `track` accepts: a letter, then up to 79 letters, numbers and `_ . : -`.
final RegExp eventNamePattern = RegExp(r'^[A-Za-z][A-Za-z0-9_.:-]{0,79}$');

final RegExp _clientKey = RegExp(r'^kma_pk_(live|test)_[A-Za-z0-9]{20,64}$');
const int _batchSize = 50;
const int _flushAt = 30;
const int _heartbeatMs = 60000;
const int _maxPropertiesBytes = 32000;

/// What the app's platform says about the device, sent as each request's context.
class KmaDevice {
  /// Describes the device.
  const KmaDevice({
    required this.platform,
    required this.osName,
    required this.osVersion,
    required this.deviceType,
    required this.screenWidth,
    required this.screenHeight,
    required this.timezone,
    required this.language,
    this.deviceModel,
  });

  /// `ios` or `android`.
  final String platform;

  /// Such as iOS, iPadOS or Android.
  final String osName;

  /// Such as 18.1.
  final String osVersion;

  /// `mobile` or `tablet`.
  final String deviceType;

  /// Such as iPhone15,4 or Pixel 8.
  final String? deviceModel;

  /// The screen's size in points (iOS) or density-independent pixels (Android).
  final int screenWidth;

  /// The screen's size in points (iOS) or density-independent pixels (Android).
  final int screenHeight;

  /// An IANA time zone such as Africa/Lagos.
  final String timezone;

  /// A language tag such as en-NG.
  final String language;
}

/// Where the client keeps its IDs and offline queue between launches.
abstract class KmaStorage {
  /// The text saved under [name], or null.
  Future<String?> read(String name);

  /// Saves [value] under [name].
  Future<void> write(String name, String value);
}

/// The server's answer to one request.
class KmaResponse {
  /// The answer's status code and body.
  const KmaResponse(this.status, [this.body = '']);

  /// The HTTP status code.
  final int status;

  /// The response body, for logging when events are refused.
  final String body;

  /// Whether the server took the events.
  bool get ok => status >= 200 && status < 300;
}

/// Sends one JSON body; throws when the request could not be made.
typedef KmaTransport = Future<KmaResponse> Function(
  Uri url,
  Map<String, String> headers,
  String body,
);

/// What the client needs from the app's platform.
class KmaEnvironment {
  /// Describes the platform.
  const KmaEnvironment({
    required this.storage,
    required this.device,
    required this.post,
    required this.sdk,
    this.now,
    this.log,
  });

  /// Without storage, every launch counts as a new install.
  final KmaStorage? storage;

  /// The device as it is now; called each time a request is built.
  final KmaDevice Function() device;

  /// Sends requests.
  final KmaTransport post;

  /// Such as kma-flutter/1.0.0.
  final String sdk;

  /// Milliseconds since the epoch. The system clock by default.
  final int Function()? now;

  /// Where debug messages go.
  final void Function(String message)? log;
}

/// A random version 4 UUID.
String uuid() {
  final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-${hex.substring(20)}';
}

final Random _random = _secureRandom();

Random _secureRandom() {
  try {
    return Random.secure();
  } on UnsupportedError {
    return Random();
  }
}

String _iso(int milliseconds) =>
    DateTime.fromMillisecondsSinceEpoch(milliseconds, isUtc: true).toIso8601String();

String? _text(Object? value) => value is String ? value : null;

int? _whole(Object? value) => value is num ? value.toInt() : null;

class _Session {
  _Session({required this.id, required this.started, required this.last, this.firstScreen});

  final String id;
  final int started;
  int last;
  String? firstScreen;

  Map<String, Object?> toJson() => {
        'id': id,
        'started': started,
        'last': last,
        if (firstScreen != null) 'firstScreen': firstScreen,
      };

  static _Session? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = _text(json['id']);
    final started = _whole(json['started']);
    final last = _whole(json['last']);
    if (id == null || started == null || last == null) return null;
    return _Session(id: id, started: started, last: last, firstScreen: _text(json['firstScreen']));
  }
}

class _QueuedEvent {
  _QueuedEvent({
    required this.name,
    required this.insertId,
    required this.time,
    required this.properties,
    required this.userId,
    required this.anonymousId,
    required this.sessionId,
    required this.sessionStartedAt,
    this.screen,
  });

  final String name;
  final String insertId;
  final String time;
  final String? screen;
  final Map<String, Object?> properties;
  final String? userId;
  final String anonymousId;
  final String sessionId;
  final String sessionStartedAt;

  /// The event as the server takes it.
  Map<String, Object?> toWire() => {
        'name': name,
        'insert_id': insertId,
        'time': time,
        if (screen != null) 'screen': screen,
        'properties': properties,
        'user_id': userId,
      };

  Map<String, Object?> toJson() => {
        ...toWire(),
        'anonymous_id': anonymousId,
        'session_id': sessionId,
        'session_started_at': sessionStartedAt,
      };

  static _QueuedEvent? fromJson(Object? json) {
    if (json is! Map) return null;
    final name = _text(json['name']);
    final insertId = _text(json['insert_id']);
    final time = _text(json['time']);
    final anonymousId = _text(json['anonymous_id']);
    final sessionId = _text(json['session_id']);
    final startedAt = _text(json['session_started_at']);
    final properties = json['properties'];
    if (name == null ||
        insertId == null ||
        time == null ||
        anonymousId == null ||
        sessionId == null ||
        startedAt == null) {
      return null;
    }
    return _QueuedEvent(
      name: name,
      insertId: insertId,
      time: time,
      screen: _text(json['screen']),
      properties: properties is Map<String, Object?> ? properties : <String, Object?>{},
      userId: _text(json['user_id']),
      anonymousId: anonymousId,
      sessionId: sessionId,
      sessionStartedAt: startedAt,
    );
  }
}

/// Records events for one project and sends them in batches, keeping them through restarts
/// and connection loss. The `KissMyApps` class runs one of these for the app.
class KmaClient {
  /// A client for the project whose client key is [key]. Throws an [ArgumentError] when
  /// the key is not a client key or the endpoint is not a web address.
  KmaClient(this.key, this.options, this._env)
      : endpoint = _endpointFrom(options.endpoint),
        _storageName = _storageNameFor(key) {
    _anonymousId = uuid();
    ready = _load();
  }

  /// Whether [key] looks like a project's client key, `kma_pk_live_…` or `kma_pk_test_…`.
  static bool isClientKey(String key) => _clientKey.hasMatch(key);

  static String _storageNameFor(String key) {
    if (!isClientKey(key)) {
      // The key itself stays out of the message: it could be a secret server key.
      throw ArgumentError('KissMyApps needs a client key that starts with kma_pk_.');
    }
    return 'kma_${key.substring(key.length - 8)}';
  }

  static Uri _endpointFrom(String value) {
    final endpoint = Uri.tryParse(value.trim().replaceAll(RegExp(r'/+$'), ''));
    if (endpoint == null ||
        !(endpoint.isScheme('https') || endpoint.isScheme('http')) ||
        endpoint.host.isEmpty) {
      throw ArgumentError('KissMyApps needs an endpoint that starts with https://.');
    }
    return endpoint;
  }

  /// The project's client key.
  final String key;

  /// The options the client was started with.
  final KissMyAppsOptions options;

  /// Where events go, without a trailing slash.
  final Uri endpoint;

  final KmaEnvironment _env;
  final String _storageName;

  /// Completes once saved state is read; calls made before then wait for it.
  late final Future<void> ready;

  late String _anonymousId;
  String? _userId;
  Map<String, Object?>? _traits;
  _Session? _session;
  bool _optedOut = false;
  String? _version;
  String? _build;

  List<_QueuedEvent> _queue = [];
  String? _screenName;
  int _foregroundAt = 0;
  bool _launched = false;
  bool _loaded = false;
  final List<void Function()> _waiting = [];
  Timer? _flushTimer;
  Timer? _heartbeatTimer;
  Timer? _saveTimer;
  Future<void>? _inflight;
  Future<void>? _leaving;
  int _failures = 0;
  int _lastSent = 0;
  bool _identityPending = false;
  bool _inForeground = false;
  bool _firstLaunch = false;
  bool _stopped = false;

  // Public API -------------------------------------------------------------------------

  /// Records something a person did.
  void track(String name, [Map<String, Object?> properties = const {}]) {
    _whenLoaded(() {
      if (_stopped || _optedOut) return;
      if (!eventNamePattern.hasMatch(name)) {
        _warn('"$name" is not a valid event name: use letters, numbers and _ . : - (up to 80).');
        return;
      }
      _enqueue(name, properties, _ensureSession());
    });
  }

  /// Records a screen view; later events carry the screen's name.
  void screen(String name, [Map<String, Object?> properties = const {}]) {
    var screen = name.trim();
    if (screen.length > 300) screen = screen.substring(0, 300);
    if (screen.isEmpty) {
      _warn('screen needs a name.');
      return;
    }
    _whenLoaded(() {
      if (_stopped || _optedOut) return;
      final previous = _screenName;
      _screenName = screen;
      final session = _ensureSession();
      if (session.firstScreen == null) {
        session.firstScreen = screen;
        _save();
      }
      _enqueue(
        'screen_viewed',
        {'name': screen, if (previous != null) 'previous': previous, ...properties},
        session,
      );
    });
  }

  /// Ties this install to your own user ID, with optional traits such as email, name or plan.
  void identify(String userId, [Map<String, Object?>? traits]) {
    final id = userId.trim();
    if (id.isEmpty || id.length > 200) {
      _warn('identify needs a user ID of 1 to 200 characters.');
      return;
    }
    _whenLoaded(() {
      _userId = id;
      if (traits != null) _traits = {...?_traits, ..._clean(traits)};
      _identityPending = true;
      _save();
      _scheduleFlush(0);
    });
  }

  /// Updates traits for the current person without changing who they are.
  void setTraits(Map<String, Object?> traits) {
    _whenLoaded(() {
      _traits = {...?_traits, ..._clean(traits)};
      _identityPending = true;
      _save();
      _scheduleFlush(0);
    });
  }

  /// Forgets the user, for example on sign out: what follows is a new person and session.
  void reset() {
    _whenLoaded(() {
      // What was recorded so far goes out under the person it belongs to.
      unawaited(flush());
      _userId = null;
      _traits = null;
      _identityPending = false;
      _anonymousId = uuid();
      _session = null;
      _save();
      if (_inForeground) _ensureSession();
    });
  }

  /// Stops recording and drops anything not sent yet, until [optIn]. Remembered across
  /// launches.
  void optOut() {
    _whenLoaded(() {
      _optedOut = true;
      _queue = [];
      _save();
    });
  }

  /// Starts recording again after [optOut].
  void optIn() {
    _whenLoaded(() {
      _optedOut = false;
      _save();
    });
  }

  /// This install's random ID.
  String get anonymousId => _anonymousId;

  /// The ID given to [identify], until [reset].
  String? get userId => _userId;

  /// The current session's ID, or null before the first event.
  String? get sessionId => _session?.id;

  /// Sends everything queued now.
  Future<void> flush() {
    if (!_loaded) return ready.then((_) => flush());
    return _inflight ??= _sendQueued().whenComplete(() => _inflight = null);
  }

  /// Stops timers; the client records nothing more.
  void shutdown() {
    _stopped = true;
    _inForeground = false;
    _flushTimer?.cancel();
    _heartbeatTimer?.cancel();
    if (_saveTimer != null) unawaited(_writeNow());
  }

  // App lifecycle, called by the platform layer ---------------------------------------

  /// The app came to the front. The first call is the launch.
  void foreground() {
    _leaving = null;
    _whenLoaded(() {
      if (_stopped || _inForeground) return;
      final launch = !_launched;
      _launched = true;
      _inForeground = true;
      _foregroundAt = _now();
      if (_optedOut) return;
      final session = _ensureSession();
      if (options.trackLifecycle) {
        if (launch) _recordInstallOrUpdate(session);
        _enqueue('app_opened', {'from_background': !launch}, session);
      }
      _heartbeatTimer ??= Timer.periodic(
        const Duration(milliseconds: _heartbeatMs),
        (_) => _heartbeat(),
      );
    });
  }

  /// The app went to the background: records it and sends what is queued while it can.
  /// Completes once that send is over, so the platform can let the app sleep. Called again
  /// before then, it returns the same future.
  Future<void> background() {
    final leaving = _leaving;
    if (leaving != null) return leaving;
    final done = Completer<void>();
    final future = _leaving = done.future;
    unawaited(future.whenComplete(() {
      if (identical(_leaving, future)) _leaving = null;
    }));
    _whenLoaded(() {
      if (_stopped || !_inForeground) {
        done.complete();
        return;
      }
      _inForeground = false;
      _heartbeatTimer?.cancel();
      _heartbeatTimer = null;
      if (_optedOut) {
        done.complete();
        return;
      }
      final session = _session;
      if (session != null && options.trackLifecycle) {
        final seconds = ((_now() - _foregroundAt) / 1000).round();
        _enqueue('app_backgrounded', {'seconds_in_foreground': max(0, seconds)}, session);
      }
      session?.last = _now();
      unawaited(
        Future.wait<void>([_writeNow(), flush()])
            .then<void>((_) {}, onError: (Object _) {})
            .whenComplete(done.complete),
      );
    });
    return done.future;
  }

  // State ------------------------------------------------------------------------------

  Future<void> _load() async {
    final storage = _env.storage;
    if (storage == null) _warn('No storage was given, so each launch counts as a new install.');
    Map<String, Object?>? saved;
    var queue = <_QueuedEvent>[];
    try {
      final raw = await storage?.read(_storageName);
      final state = raw == null ? null : jsonDecode(raw);
      saved = state is Map<String, Object?> ? state : null;
      final rawQueue = await storage?.read('${_storageName}_queue');
      final events = rawQueue == null ? null : jsonDecode(rawQueue);
      if (events is List) {
        queue = events.map(_QueuedEvent.fromJson).whereType<_QueuedEvent>().toList();
      }
    } catch (_) {
      saved = null;
    }
    final anonymousId = _text(saved?['anonymousId']);
    if (saved != null && anonymousId != null && anonymousId.isNotEmpty) {
      final traits = saved['traits'];
      _anonymousId = anonymousId;
      _userId = _text(saved['userId']);
      _traits = traits is Map<String, Object?> ? traits : null;
      _session = _Session.fromJson(saved['session']);
      _optedOut = saved['optedOut'] == true;
      _version = _text(saved['version']);
      _build = _text(saved['build']);
      _firstLaunch = false;
    } else {
      // Nothing saved means a first launch, or the app's data was cleared.
      _firstLaunch = true;
    }
    _queue = queue;
    _identityPending = _traits != null;
    _loaded = true;
    // What an earlier launch could not send goes now.
    if (_queue.isNotEmpty) _scheduleFlush(0);
    final waiting = List.of(_waiting);
    _waiting.clear();
    for (final run in waiting) {
      run();
    }
  }

  void _whenLoaded(void Function() run) {
    if (_loaded) {
      run();
    } else {
      _waiting.add(run);
    }
  }

  void _recordInstallOrUpdate(_Session session) {
    final version = options.appVersion;
    final build = options.build;
    if (_firstLaunch) {
      _enqueue(
        'app_installed',
        {if (version != null) 'version': version, if (build != null) 'build': build},
        session,
      );
    } else if ((version != null && _version != null && version != _version) ||
        (build != null && _build != null && build != _build)) {
      _enqueue(
        'app_updated',
        {
          if (version != null) 'version': version,
          if (build != null) 'build': build,
          if (_version != null) 'previous_version': _version,
          if (_build != null) 'previous_build': _build,
        },
        session,
      );
    }
    _firstLaunch = false;
    _version = version ?? _version;
    _build = build ?? _build;
    _save();
  }

  Map<String, Object?> _stateJson() => {
        'anonymousId': _anonymousId,
        'userId': _userId,
        'traits': _traits,
        'session': _session?.toJson(),
        'optedOut': _optedOut,
        if (_version != null) 'version': _version,
        if (_build != null) 'build': _build,
      };

  void _save() {
    if (_saveTimer != null) return;
    _saveTimer = Timer(const Duration(milliseconds: 250), () {
      _saveTimer = null;
      unawaited(_writeNow());
    });
  }

  Future<void> _writeNow() async {
    _saveTimer?.cancel();
    _saveTimer = null;
    final storage = _env.storage;
    if (storage == null) return;
    try {
      final state = jsonEncode(_stateJson());
      final queue = jsonEncode([for (final event in _queue) event.toJson()]);
      await storage.write(_storageName, state);
      await storage.write('${_storageName}_queue', queue);
    } catch (_) {
      // Storage full or failing: the client keeps working in memory.
    }
  }

  // Sessions and events ----------------------------------------------------------------

  int _now() => _env.now?.call() ?? DateTime.now().millisecondsSinceEpoch;

  _Session _ensureSession() {
    final now = _now();
    final timeout = options.sessionTimeoutMinutes * 60000;
    var session = _session;
    if (session == null || now - session.last > timeout) {
      session = _Session(id: uuid(), started: now, last: now, firstScreen: _screenName);
      _session = session;
      _enqueue('session_started', const {}, session);
    } else {
      session.last = now;
    }
    return session;
  }

  void _enqueue(String name, Map<String, Object?> properties, _Session session) {
    _queue.add(_QueuedEvent(
      name: name,
      insertId: uuid(),
      time: _iso(_now()),
      screen: _screenName,
      properties: _clean(properties),
      userId: _userId,
      anonymousId: _anonymousId,
      sessionId: session.id,
      sessionStartedAt: _iso(session.started),
    ));
    final limit = max(1, options.maxQueue);
    if (_queue.length > limit) _queue.removeRange(0, _queue.length - limit);
    _save();
    _scheduleFlush(_queue.length >= _flushAt ? 0 : options.flushIntervalSeconds * 1000);
  }

  /// Properties as plain JSON: dates become ISO text, other objects their `toString`.
  Map<String, Object?> _clean(Map<String, Object?> properties) {
    if (properties.isEmpty) return <String, Object?>{};
    try {
      final json = jsonEncode(properties, toEncodable: _encodable);
      if (utf8.encode(json).length > _maxPropertiesBytes) {
        _warn('Event properties are over 32 KB and were dropped.');
        return <String, Object?>{};
      }
      final parsed = jsonDecode(json);
      return parsed is Map<String, Object?> ? parsed : <String, Object?>{};
    } catch (_) {
      return <String, Object?>{};
    }
  }

  static Object? _encodable(Object? value) {
    if (value is DateTime) return value.toUtc().toIso8601String();
    if (value is Enum) return value.name;
    if (value is Iterable) return value.toList();
    if (value is Map) return value.map((key, item) => MapEntry(key.toString(), item));
    if (value is num) return null; // NaN and infinity have no JSON form.
    return value.toString();
  }

  // Sending ----------------------------------------------------------------------------

  Map<String, Object?> _context(_Session? session) {
    final device = _env.device();
    final firstScreen = session?.firstScreen;
    return {
      'platform': device.platform,
      'sdk': _env.sdk,
      'timezone': device.timezone,
      'language': device.language,
      'device_type': device.deviceType,
      if (device.deviceModel != null) 'device_model': device.deviceModel,
      'os_name': device.osName,
      'os_version': device.osVersion,
      if (options.appVersion != null) 'app_version': options.appVersion,
      'screen_width': device.screenWidth,
      'screen_height': device.screenHeight,
      if (firstScreen != null) 'page_path': firstScreen,
    };
  }

  /// One request's body: queued events share a person and session; with none, a heartbeat.
  Map<String, Object?> _body(List<_QueuedEvent> batch) {
    final head = batch.isEmpty ? null : batch.first;
    final session = _session;
    final sessionId = head?.sessionId ?? session?.id;
    final startedAt = head?.sessionStartedAt ?? (session == null ? null : _iso(session.started));
    final live = session != null && session.id == sessionId ? session : null;
    final current = head == null || head.anonymousId == _anonymousId;
    final userId = current ? _userId : batch.last.userId;
    final traits = _traits;
    return {
      'anonymous_id': head?.anonymousId ?? _anonymousId,
      if (sessionId != null) 'session': {'id': sessionId, 'started_at': startedAt},
      'sent_at': _iso(_now()),
      'context': _context(live),
      'events': [for (final event in batch) event.toWire()],
      if (userId != null) 'user_id': userId,
      if (current && traits != null) 'traits': traits,
    };
  }

  List<_QueuedEvent> _nextBatch() {
    if (_queue.isEmpty) return const [];
    final head = _queue.first;
    final batch = <_QueuedEvent>[];
    for (final event in _queue) {
      if (event.sessionId != head.sessionId ||
          event.anonymousId != head.anonymousId ||
          batch.length >= _batchSize) {
        break;
      }
      batch.add(event);
    }
    return batch;
  }

  Future<KmaResponse> _post(Map<String, Object?> body) {
    return _env.post(
      endpoint.replace(path: '${endpoint.path}/v1/events'),
      {'content-type': 'application/json', 'authorization': 'Bearer $key'},
      jsonEncode(body),
    );
  }

  Future<void> _sendQueued() async {
    while (!_stopped && !_optedOut) {
      final batch = _nextBatch();
      if (batch.isEmpty && !(_identityPending && _session != null)) return;
      final traitsSent = _traits;
      final carriesIdentity = batch.isEmpty || batch.first.anonymousId == _anonymousId;
      KmaResponse response;
      try {
        response = await _post(_body(batch));
      } catch (_) {
        _retryLater();
        return;
      }
      final status = response.status;
      final refused = status >= 400 && status < 500 && status != 408 && status != 429;
      if (!response.ok && !refused) {
        _retryLater();
        return;
      }
      if (refused) _warn('Events were refused ($status): ${response.body}');
      final sent = {for (final event in batch) event.insertId};
      _queue.removeWhere((event) => sent.contains(event.insertId));
      // Traits are sent once. Refused on their own, they would be refused again.
      if (carriesIdentity && identical(_traits, traitsSent) && (response.ok || batch.isEmpty)) {
        _traits = null;
        _identityPending = false;
      }
      _failures = 0;
      _lastSent = _now();
      _save();
    }
  }

  void _retryLater() {
    _failures += 1;
    _scheduleFlush(min(60000, 1000 * pow(2, min(_failures, 6)).toInt()), replace: true);
  }

  void _scheduleFlush(int delay, {bool replace = false}) {
    if (_stopped) return;
    final timer = _flushTimer;
    if (timer != null) {
      if (delay > 0 && !replace) return;
      timer.cancel();
    }
    _flushTimer = Timer(Duration(milliseconds: delay), () {
      _flushTimer = null;
      unawaited(flush());
    });
  }

  /// Keeps an open app counted as online.
  void _heartbeat() {
    final session = _session;
    if (_stopped || _optedOut || !_inForeground || session == null) return;
    session.last = _now();
    if (_queue.isNotEmpty || _identityPending) {
      unawaited(flush());
      return;
    }
    if (_now() - _lastSent < _heartbeatMs - 1000) return;
    unawaited(_beat());
  }

  Future<void> _beat() async {
    try {
      await _post(_body(const []));
      _lastSent = _now();
    } catch (_) {
      // Offline: the next heartbeat tries again.
    }
  }

  void _warn(String message) {
    if (options.debug) _env.log?.call('KissMyApps: $message');
  }
}
