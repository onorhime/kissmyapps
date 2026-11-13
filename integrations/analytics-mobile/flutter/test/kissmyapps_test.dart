// The Flutter layer: start reads the device from the native side, the app's lifecycle drives
// the client, and KissMyAppsObserver turns routes into screen views.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kissmyapps/kissmyapps.dart';
import 'package:kissmyapps/src/client.dart';
import 'package:kissmyapps/src/kissmyapps.dart';

const key = 'kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ';
const channel = MethodChannel('kissmyapps');
const links = EventChannel('kissmyapps/links');
const deviceKey = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

class MemoryStorage implements KmaStorage {
  final Map<String, String> data = {};

  @override
  Future<String?> read(String name) async => data[name];

  @override
  Future<void> write(String name, String value) async => data[name] = value;
}

const pixel = <String, Object?>{
  'osName': 'Android',
  'osVersion': '15',
  'deviceType': 'mobile',
  'deviceModel': 'Pixel 8',
  'screenWidth': 411.4,
  'screenHeight': 914,
  'timezone': 'Africa/Lagos',
  'language': 'en-NG',
  'appVersion': '2.4.0',
  'build': '120',
  'storageDirectory': '/data/user/0/app/no_backup/kissmyapps',
};

void main() {
  final calls = <String>[];
  final arguments = <String, Object?>{};
  final sent = <Map<String, dynamic>>[];
  final attribution = <({String path, Map<String, dynamic> body})>[];
  String? initialLink;
  Map<String, Object?>? attributionInfo;
  Object? Function(String path) reply = (_) => {};
  MockStreamHandlerEventSink? linkSink;
  var listening = 0;

  setUp(() {
    calls.clear();
    arguments.clear();
    sent.clear();
    attribution.clear();
    initialLink = null;
    attributionInfo = null;
    reply = (_) => {};
    linkSink = null;
    listening = 0;
    debugStorage = MemoryStorage();
    debugTransport = (url, headers, body) async {
      final path = url.path;
      if (path == '/v1/events') {
        sent.add(jsonDecode(body) as Map<String, dynamic>);
      } else {
        attribution.add((path: path, body: jsonDecode(body) as Map<String, dynamic>));
      }
      return KmaResponse(200, jsonEncode(reply(path)));
    };
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      arguments[call.method] = call.arguments;
      return switch (call.method) {
        'info' => pixel,
        'initialLink' => initialLink,
        'attributionInfo' => attributionInfo,
        _ => null,
      };
    });
    // An event channel nobody answers would never start listening in a widget test.
    messenger.setMockStreamHandler(
      links,
      MockStreamHandler.inline(
        onListen: (_, sink) {
          listening += 1;
          linkSink = sink;
        },
        onCancel: (_) => listening -= 1,
      ),
    );
  });

  tearDown(() {
    debugResetKissMyApps();
    debugStorage = null;
    debugTransport = null;
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, null);
    messenger.setMockStreamHandler(links, null);
  });

  // The calls that are not about attribution, which has its own tests below.
  List<String> lifecycleCalls() => [
        for (final method in calls)
          if (method == 'info' || method == 'releaseBackground') method
      ];

  List<String> names() => [
        for (final body in sent)
          for (final event in body['events'] as List) (event as Map)['name'] as String,
      ];

  List<Object?> screens() => [
        for (final body in sent)
          for (final event in body['events'] as List)
            if ((event as Map)['name'] == 'screen_viewed') (event['properties'] as Map)['name'],
      ];

  testWidgets('starts from the device, follows the app and records each page', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    KissMyApps.track('before_start');
    await KissMyApps.start(key);
    expect(lifecycleCalls(), ['info']);
    expect(KissMyApps.anonymousId, isNotNull);

    await tester.pumpWidget(MaterialApp(
      navigatorObservers: [KissMyAppsObserver()],
      routes: {
        '/': (_) => const Text('Home'),
        '/lesson': (_) => const Text('Lesson'),
      },
    ));
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    unawaited(navigator.pushNamed('/lesson'));
    await tester.pumpAndSettle();
    unawaited(showDialog<void>(
      context: navigator.context,
      builder: (_) => const Text('Are you sure?'),
    ));
    await tester.pumpAndSettle();
    navigator.pop();
    await tester.pumpAndSettle();
    navigator.pop();
    await tester.pumpAndSettle();

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 1));

    expect(names(), [
      'session_started',
      'app_installed',
      'app_opened',
      'before_start',
      'screen_viewed',
      'screen_viewed',
      'screen_viewed',
      'app_backgrounded',
    ]);
    expect(screens(), ['/', '/lesson', '/']);
    // The second release, for paused after hidden, finds nothing held.
    expect(lifecycleCalls(), ['info', 'releaseBackground', 'releaseBackground']);
    // The first batch goes with the install call, before the first page; the last has it.
    final context = sent.last['context'] as Map<String, dynamic>;
    expect(context, {
      'platform': 'android',
      'sdk': 'kma-flutter/$sdkVersion',
      'timezone': 'Africa/Lagos',
      'language': 'en-NG',
      'device_type': 'mobile',
      'device_model': 'Pixel 8',
      'os_name': 'Android',
      'os_version': '15',
      'app_version': '2.4.0',
      'screen_width': 411,
      'screen_height': 914,
      'page_path': '/',
    });

    sent.clear();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await KissMyApps.flush();
    expect(names(), ['app_opened']);
    expect(calls.where((method) => method == 'info'), hasLength(2));
    debugResetKissMyApps();
  });

  testWidgets('waits for the first resume when started off screen', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await KissMyApps.start(key);
    await KissMyApps.flush();
    expect(sent, isEmpty);
    expect(attribution, isEmpty);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await KissMyApps.flush();
    expect(names(), ['session_started', 'app_installed', 'app_opened']);
    await tester.pump(const Duration(milliseconds: 100));
    expect(attribution.map((call) => call.path), ['/v1/attribution/install']);
    debugResetKissMyApps();
  });

  testWidgets('does nothing without a client key or the native side', (tester) async {
    final logs = <String?>[];
    final print = debugPrint;
    debugPrint = (message, {wrapWidth}) => logs.add(message);

    await expectLater(
        KissMyApps.start('kma_sk_live_ABCDEFGHJKLMNPQRSTUVWXYZ'), throwsAssertionError);
    expect(debugClient, isNull);
    expect(logs.single, contains('kma_pk_'));
    expect(logs.single, isNot(contains('ABCDEFGH')));

    debugResetKissMyApps();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async => throw MissingPluginException());
    await KissMyApps.start(key);
    expect(debugClient, isNull);
    expect(logs.last, contains('could not read the device'));
    KissMyApps.track('ignored');
    await KissMyApps.flush();
    expect(sent, isEmpty);
    debugPrint = print;
  });

  testWidgets('records nothing on platforms other than Android and iOS', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    await KissMyApps.start(key);
    debugDefaultTargetPlatformOverride = null;
    expect(calls, isEmpty);
    expect(debugClient, isNull);
  });

  testWidgets('lets an app name its own screens', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await KissMyApps.start(key);
    final observer = KissMyAppsObserver(
      nameExtractor: (settings) => settings.name == '/' ? 'Home' : null,
    );
    await tester.pumpWidget(MaterialApp(
      navigatorObservers: [observer],
      onGenerateRoute: (settings) => MaterialPageRoute<void>(
        settings: settings,
        builder: (_) => Text(settings.name ?? ''),
      ),
    ));
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    unawaited(navigator.pushNamed('/unnamed'));
    await tester.pumpAndSettle();
    await KissMyApps.flush();
    expect(screens(), ['Home']);
    debugResetKissMyApps();
  });

  testWidgets('matches the install from the plugin, and reports links from the link stream',
      (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    initialLink = 'https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4';
    attributionInfo = {
      'deviceKey': deviceKey,
      'referrer': 'kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok',
      'referrerClickTs': 1761818300,
      'installBeginTs': 1761818320,
    };
    reply = (path) => {
          'matched': true,
          'method': 'link_open',
          'deep_link': path == '/v1/attribution/install'
              ? {
                  'value': 'lesson',
                  'params': {'id': '4'},
                  'deferred': true,
                }
              : {'value': 'promo', 'params': {}, 'deferred': false},
        };
    final delivered = <KissMyAppsDeepLink>[];
    // Set before start: the deep link waits for it.
    final stop = KissMyApps.onDeepLink(delivered.add);
    await KissMyApps.start(key);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));

    expect(listening, 1);
    expect(arguments['attributionInfo'], {'install': true, 'clipboard': false});
    expect(attribution.map((call) => call.path), ['/v1/attribution/install']);
    expect(attribution.single.body, {
      'anonymous_id': KissMyApps.anonymousId,
      'session_id': KissMyApps.sessionId,
      'platform': 'android',
      'installed_at': isA<String>(),
      'sdk': 'kma-flutter/$sdkVersion',
      'app_version': '2.4.0',
      'device_key': deviceKey,
      'link_url': 'https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4',
      'referrer': 'kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok',
      'referrer_click_ts': 1761818300,
      'install_begin_ts': 1761818320,
    });
    expect(delivered, [
      KissMyAppsDeepLink(
        value: 'lesson',
        params: const {'id': '4'},
        deferred: true,
        url: Uri.parse('https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4'),
      ),
    ]);

    // A link while the app runs, and the same link from the app itself, count once.
    attribution.clear();
    linkSink!.success('https://fluent.go.kissmyapps.dev/promo');
    expect(KissMyApps.handleDeepLink(Uri.parse('https://fluent.go.kissmyapps.dev/promo')), isTrue);
    expect(KissMyApps.handleDeepLink(Uri.parse('fluent://lesson/4')), isFalse);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(attribution.map((call) => call.path), ['/v1/attribution/open']);
    expect(attribution.single.body['url'], 'https://fluent.go.kissmyapps.dev/promo');
    expect(attribution.single.body['device_key'], deviceKey);
    expect(
        delivered.last, isA<KissMyAppsDeepLink>().having((link) => link.value, 'value', 'promo'));
    expect(delivered, hasLength(2));

    stop();
    debugResetKissMyApps();
    expect(listening, 0);
  });

  testWidgets('keeps links and handlers given before start', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    expect(KissMyApps.handleDeepLink(Uri.parse('https://fluent.go.kissmyapps.dev/early')), isTrue);
    expect(KissMyApps.handleDeepLink(Uri.parse('mailto:hello@example.test')), isFalse);
    await KissMyApps.start(key);
    await tester.pump(const Duration(milliseconds: 100));
    expect(attribution.single.body['link_url'], 'https://fluent.go.kissmyapps.dev/early');
    debugResetKissMyApps();
  });

  testWidgets(
      'leaves links to the app with deepLinks off, and works without the attribution '
      'methods', (tester) async {
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    // An app built with the 1.0 plugin answers the new methods with MissingPluginException.
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      if (call.method == 'info') return pixel;
      if (call.method == 'releaseBackground') return null;
      throw MissingPluginException();
    });
    await KissMyApps.start(key, options: const KissMyAppsOptions(deepLinks: false));
    await tester.pump(const Duration(milliseconds: 100));
    expect(listening, 0);
    expect(calls, isNot(contains('initialLink')));
    expect(calls, contains('attributionInfo'));
    expect(attribution.map((call) => call.path), ['/v1/attribution/install']);
    expect(attribution.single.body, isNot(contains('device_key')));
    debugResetKissMyApps();
  });
}
