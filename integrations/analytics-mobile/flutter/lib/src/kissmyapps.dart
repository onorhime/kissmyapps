import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'client.dart';
import 'options.dart';
import 'platform/platform.dart' as platform;

/// KissMyApps analytics for Flutter: sessions, installs, updates, opens, screens and your own
/// events, sent to your KissMyApps project.
///
/// Call [start] once at launch, then [track], [screen] and [identify] from anywhere. Every
/// call returns at once; calls made before [start] are kept and run once it has started.
/// It records on Android and iOS, and does nothing on other platforms.
abstract final class KissMyApps {
  static const MethodChannel _channel = MethodChannel('kissmyapps');
  static KmaClient? _client;
  static Future<void>? _starting;
  static _Lifecycle? _lifecycle;
  static KmaDevice? _device;
  // Calls made before start run once it is called.
  static final List<void Function(KmaClient client)> _early = [];

  /// Starts the SDK with the project's client key, from Settings > API keys in the console.
  ///
  /// Call it once, as early as possible, for example in `main` before `runApp`. There is no
  /// need to wait for it: calls made in the meantime are kept.
  static Future<void> start(String key, {KissMyAppsOptions options = const KissMyAppsOptions()}) {
    return _starting ??= _start(key, options);
  }

  /// Records something a person did, such as `lesson_completed`, with optional properties.
  ///
  /// Names start with a letter and use letters, numbers and `_ . : -`, up to 80
  /// characters; other names are ignored.
  static void track(String name, {Map<String, Object?> properties = const {}}) {
    _call((client) => client.track(name, properties));
  }

  /// Records a screen view; later events carry the screen's name. [KissMyAppsObserver] calls
  /// this for every route.
  static void screen(String name, {Map<String, Object?> properties = const {}}) {
    _call((client) => client.screen(name, properties));
  }

  /// Ties this install to your own user ID, with optional traits such as email, name or plan.
  static void identify(String userId, {Map<String, Object?>? traits}) {
    _call((client) => client.identify(userId, traits));
  }

  /// Updates traits for the current person without changing who they are.
  static void setTraits(Map<String, Object?> traits) {
    _call((client) => client.setTraits(traits));
  }

  /// Forgets the user, for example on sign out: what follows is a new person and session.
  static void reset() {
    _call((client) => client.reset());
  }

  /// Stops recording and drops anything not sent yet, until [optIn]. Remembered across
  /// launches.
  static void optOut() {
    _call((client) => client.optOut());
  }

  /// Starts recording again after [optOut].
  static void optIn() {
    _call((client) => client.optIn());
  }

  /// Sends everything queued now.
  static Future<void> flush() async {
    if (_client == null) await _starting;
    await _client?.flush();
  }

  /// This install's random ID, for support tickets. Null until [start] has finished.
  static String? get anonymousId => _client?.anonymousId;

  /// The current session's ID. Null until [start] has finished.
  static String? get sessionId => _client?.sessionId;

  static void _call(void Function(KmaClient client) run) {
    final client = _client;
    if (client != null) {
      run(client);
    } else if (_early.length < 100) {
      _early.add(run);
    }
  }

  static Future<void> _start(String key, KissMyAppsOptions options) async {
    final supported = !kIsWeb &&
        (defaultTargetPlatform == TargetPlatform.android ||
            defaultTargetPlatform == TargetPlatform.iOS);
    if (!supported) {
      if (options.debug) {
        debugPrint('KissMyApps: nothing is recorded on this platform; it runs on Android and iOS.');
      }
      return;
    }
    if (!KmaClient.isClientKey(key)) {
      const message = 'KissMyApps: start needs a client key that starts with kma_pk_, '
          'from Settings > API keys in the console.';
      debugPrint(message);
      assert(false, message);
      return;
    }
    WidgetsFlutterBinding.ensureInitialized();
    final Map<String, Object?> info;
    try {
      info = await _channel.invokeMapMethod<String, Object?>('info') ?? const {};
    } catch (error) {
      debugPrint('KissMyApps: could not read the device, so nothing is recorded ($error).');
      return;
    }
    _device = _deviceFrom(info);
    final KmaClient client;
    try {
      client = KmaClient(
        key,
        options.withVersion(_text(info['appVersion']), _text(info['build'])),
        KmaEnvironment(
          storage: debugStorage ?? _storageFrom(info),
          device: () => _device!,
          post: debugTransport ?? platform.httpPost,
          sdk: 'kma-flutter/$sdkVersion',
          log: debugPrint,
        ),
      );
    } on ArgumentError catch (error) {
      debugPrint('KissMyApps: ${error.message}');
      assert(false, '${error.message}');
      return;
    }
    _client = client;
    _lifecycle = _Lifecycle(client, onResume: _refreshDevice, onBackground: _releaseBackground);
    final early = List.of(_early);
    _early.clear();
    for (final run in early) {
      run(client);
    }
  }

  static KmaStorage? _storageFrom(Map<String, Object?> info) {
    final directory = _text(info['storageDirectory']);
    return directory == null ? null : platform.fileStorage(directory);
  }

  /// The screen size, language and time zone can change while the app is away.
  static Future<void> _refreshDevice() async {
    try {
      final info = await _channel.invokeMapMethod<String, Object?>('info');
      if (info != null) _device = _deviceFrom(info);
    } catch (_) {
      // Keep the last known device.
    }
  }

  /// iOS keeps the app awake after it leaves the screen until the queue is sent.
  static Future<void> _releaseBackground() async {
    try {
      await _channel.invokeMethod<void>('releaseBackground');
    } catch (_) {
      // Nothing was held.
    }
  }

  static KmaDevice _deviceFrom(Map<String, Object?> info) {
    final ios = defaultTargetPlatform == TargetPlatform.iOS;
    return KmaDevice(
      platform: ios ? 'ios' : 'android',
      osName: _text(info['osName']) ?? (ios ? 'iOS' : 'Android'),
      osVersion: _text(info['osVersion']) ?? '',
      deviceType: info['deviceType'] == 'tablet' ? 'tablet' : 'mobile',
      deviceModel: _text(info['deviceModel']),
      screenWidth: _whole(info['screenWidth']),
      screenHeight: _whole(info['screenHeight']),
      timezone: _text(info['timezone']) ?? 'UTC',
      language: _text(info['language']) ??
          WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag(),
    );
  }

  static String? _text(Object? value) => value is String && value.isNotEmpty ? value : null;

  static int _whole(Object? value) => value is num ? value.round() : 0;
}

/// Replaces the file storage in tests.
@visibleForTesting
KmaStorage? debugStorage;

/// Replaces the network in tests.
@visibleForTesting
KmaTransport? debugTransport;

/// Stops the running client and forgets it, so a test can start another.
@visibleForTesting
void debugResetKissMyApps() {
  KissMyApps._client?.shutdown();
  KissMyApps._lifecycle?.dispose();
  KissMyApps._client = null;
  KissMyApps._lifecycle = null;
  KissMyApps._starting = null;
  KissMyApps._device = null;
  KissMyApps._early.clear();
}

/// The running client, for tests.
@visibleForTesting
KmaClient? get debugClient => KissMyApps._client;

/// Follows the app between foreground and background.
class _Lifecycle with WidgetsBindingObserver {
  _Lifecycle(this._client, {required this.onResume, required this.onBackground}) {
    final binding = WidgetsBinding.instance;
    binding.addObserver(this);
    // Started while the app is on screen. Otherwise the first resume is the launch.
    final state = binding.lifecycleState;
    if (state == AppLifecycleState.resumed || state == AppLifecycleState.inactive) {
      _client.foreground();
    }
  }

  final KmaClient _client;
  final Future<void> Function() onResume;
  final Future<void> Function() onBackground;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(onResume());
      _client.foreground();
    } else if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(_client.background().whenComplete(onBackground));
    }
  }

  void dispose() => WidgetsBinding.instance.removeObserver(this);
}
