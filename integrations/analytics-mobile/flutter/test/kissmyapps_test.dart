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
  final sent = <Map<String, dynamic>>[];

  setUp(() {
    calls.clear();
    sent.clear();
    debugStorage = MemoryStorage();
    debugTransport = (url, headers, body) async {
      sent.add(jsonDecode(body) as Map<String, dynamic>);
      return const KmaResponse(200, '{}');
    };
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      return call.method == 'info' ? pixel : null;
    });
  });

  tearDown(() {
    debugResetKissMyApps();
    debugStorage = null;
    debugTransport = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

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
    expect(calls, ['info']);
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
    expect(calls, ['info', 'releaseBackground', 'releaseBackground']);
    final context = sent.first['context'] as Map<String, dynamic>;
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
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await KissMyApps.flush();
    expect(names(), ['session_started', 'app_installed', 'app_opened']);
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
}
