// The client on real timers, files and dart:io HTTP, against a local server; and, when
// KMA_CONTRACT_ENDPOINT and KMA_CONTRACT_KEY are set, against a running ingest.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:kissmyapps/src/client.dart';
import 'package:kissmyapps/src/options.dart';
import 'package:kissmyapps/src/platform/io.dart';

const pixel = KmaDevice(
  platform: 'android',
  osName: 'Android',
  osVersion: '15',
  deviceType: 'mobile',
  deviceModel: 'Pixel 8',
  screenWidth: 411,
  screenHeight: 914,
  timezone: 'Africa/Lagos',
  language: 'en-NG',
);

void main() {
  test('sends over HTTP and keeps its state in files', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final bodies = <Map<String, dynamic>>[];
    final headers = <String?>{};
    final backgrounded = Completer<void>();
    server.listen((request) async {
      final body = jsonDecode(await utf8.decodeStream(request)) as Map<String, dynamic>;
      bodies.add(body);
      headers.add(request.headers.value('authorization'));
      final count = (body['events'] as List).length;
      request.response
        ..headers.contentType = ContentType.json
        ..write('{"stored":$count,"duplicates":0,"rejected":[]}');
      await request.response.close();
      if (jsonEncode(body).contains('app_backgrounded') && !backgrounded.isCompleted) {
        backgrounded.complete();
      }
    });
    final directory = await Directory.systemTemp.createTemp('kissmyapps');
    addTearDown(() async {
      await server.close(force: true);
      await directory.delete(recursive: true);
    });

    const key = 'kma_pk_test_ABCDEFGHJKLMNPQRSTUVWXYZ';
    final logs = <String>[];
    KmaClient launch() => KmaClient(
          key,
          KissMyAppsOptions(
            appVersion: '1.0.0',
            build: '1',
            endpoint: 'http://127.0.0.1:${server.port}/',
            debug: true,
          ),
          KmaEnvironment(
            storage: FileStorage(directory.path),
            device: () => pixel,
            post: httpPost,
            sdk: 'kma-flutter/$sdkVersion',
            log: logs.add,
          ),
        );

    final client = launch();
    client.foreground();
    client.screen('Home');
    client.track('lesson_completed', {'lesson': 1});
    await client.background();
    await backgrounded.future.timeout(const Duration(seconds: 10));

    expect(
      [
        for (final body in bodies)
          for (final event in body['events'] as List) (event as Map)['name'],
      ],
      [
        'session_started',
        'app_installed',
        'app_opened',
        'screen_viewed',
        'lesson_completed',
        'app_backgrounded',
      ],
    );
    expect(headers, {'Bearer $key'});
    expect((bodies.first['session'] as Map)['id'], client.sessionId);
    expect(logs, isEmpty);
    client.shutdown();

    // The next launch is the same person, not a new install.
    final again = launch();
    await again.ready;
    expect(again.anonymousId, client.anonymousId);
    again.shutdown();
  });

  test(
    'a running ingest stores everything the SDK sends',
    () async {
      final endpoint = Platform.environment['KMA_CONTRACT_ENDPOINT']!;
      final key = Platform.environment['KMA_CONTRACT_KEY']!;
      final replies = <Map<String, dynamic>>[];
      final done = Completer<void>();
      final client = KmaClient(
        key,
        KissMyAppsOptions(appVersion: '1.0.0', build: '1', endpoint: endpoint, debug: true),
        KmaEnvironment(
          storage: null,
          device: () => pixel,
          sdk: 'kma-flutter/$sdkVersion',
          log: print,
          post: (url, headers, body) async {
            final response = await httpPost(url, headers, body);
            replies.add({
              ...jsonDecode(response.body) as Map<String, dynamic>,
              'status': response.status,
            });
            if (body.contains('app_backgrounded') && !done.isCompleted) done.complete();
            return response;
          },
        ),
      );
      client.foreground();
      client.identify(
          'flutter-contract-${DateTime.now().millisecondsSinceEpoch}', {'plan': 'annual'});
      client.screen('Home');
      client.track('lesson_completed', {'lesson': 1, 'sdk': 'flutter'});
      unawaited(client.background());
      await done.future.timeout(const Duration(seconds: 15));
      // ignore: avoid_print
      print('KMA contract: anonymous_id=${client.anonymousId} replies=$replies');
      for (final reply in replies) {
        expect(reply['status'], 200, reason: '$reply');
        expect(reply['rejected'], isEmpty, reason: '$reply');
      }
      expect(replies.fold<int>(0, (sum, reply) => sum + (reply['stored'] as int)), 6);
      client.shutdown();
    },
    skip: Platform.environment['KMA_CONTRACT_ENDPOINT'] == null ||
            Platform.environment['KMA_CONTRACT_KEY'] == null
        ? 'Set KMA_CONTRACT_ENDPOINT and KMA_CONTRACT_KEY to send to a running ingest.'
        : false,
  );
}
