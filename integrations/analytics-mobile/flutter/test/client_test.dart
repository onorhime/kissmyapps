// The same cases as the React Native client's tests, so every app SDK behaves alike, plus
// the parts that are Dart's own. Each request is checked against ../contract.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kissmyapps/src/client.dart';
import 'package:kissmyapps/src/options.dart';
import 'package:kissmyapps/src/platform/io.dart';

const key = 'kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ';
int minutes(int n) => n * 60000;

final Map<String, dynamic> contract =
    jsonDecode(File('../contract/app-events.json').readAsStringSync()) as Map<String, dynamic>;

const iphone = KmaDevice(
  platform: 'ios',
  osName: 'iOS',
  osVersion: '18.1',
  deviceType: 'mobile',
  deviceModel: 'iPhone15,4',
  screenWidth: 393,
  screenHeight: 852,
  timezone: 'Africa/Lagos',
  language: 'en-NG',
);

/// Storage that answers later, as files do.
class MemoryStorage implements KmaStorage {
  final Map<String, String> data = {};

  @override
  Future<String?> read(String name) async => data[name];

  @override
  Future<void> write(String name, String value) async => data[name] = value;
}

typedef Body = Map<String, dynamic>;

/// One test's clock, network and clients, driven by fake time.
class Harness {
  Harness(this.async);

  final FakeAsync async;
  int clock = DateTime.utc(2026, 10, 30, 9, 59).millisecondsSinceEpoch;
  final List<Body> sent = [];
  Future<KmaResponse> Function() answer = ok;
  final List<KmaClient> clients = [];

  static Future<KmaResponse> ok() async => const KmaResponse(200, '{}');

  KmaClient start(
    KmaStorage? storage, {
    String clientKey = key,
    String appVersion = '2.4.0',
    String build = '120',
    int maxQueue = 1000,
    bool trackLifecycle = true,
  }) {
    final client = KmaClient(
      clientKey,
      KissMyAppsOptions(
        appVersion: appVersion,
        build: build,
        maxQueue: maxQueue,
        trackLifecycle: trackLifecycle,
      ),
      KmaEnvironment(
        storage: storage,
        device: () => iphone,
        sdk: 'kma-flutter/1.0.0',
        now: () => clock,
        post: (url, headers, body) {
          expect(url.toString(), 'https://events.kissmyapps.dev/v1/events');
          expect(headers['authorization'], 'Bearer $key');
          expect(headers['content-type'], 'application/json');
          sent.add(jsonDecode(body) as Body);
          return answer();
        },
      ),
    );
    clients.add(client);
    return client;
  }

  /// Moves the clock and the timers on by [ms], then lets pending work finish.
  void settle([int ms = 0]) {
    clock += ms;
    async.elapse(Duration(milliseconds: ms));
    async.elapse(const Duration(milliseconds: 300));
  }

  void finish() {
    for (final client in clients) {
      client.shutdown();
    }
    async.flushTimers(flushPeriodicTimers: false);
  }
}

void run(void Function(Harness h) body) {
  fakeAsync((async) {
    final harness = Harness(async);
    body(harness);
    harness.finish();
  });
}

List<Map<String, dynamic>> eventsOf(List<Body> bodies) => [
      for (final body in bodies)
        for (final event in body['events'] as List) event as Map<String, dynamic>,
    ];

List<String> names(List<Body> bodies) =>
    [for (final event in eventsOf(bodies)) event['name'] as String];

List<String> fields(Map<String, dynamic> rules) => [
      ...(rules['required'] as List).cast<String>(),
      ...((rules['optional'] as List?) ?? const []).cast<String>(),
    ];

/// The rules every app SDK is held to, from integrations/analytics-mobile/contract.
void expectContract(Body body) {
  final rules = contract;
  final bodyRules = rules['body'] as Map<String, dynamic>;
  final contextRules = rules['context'] as Map<String, dynamic>;
  final eventRules = rules['event'] as Map<String, dynamic>;
  final context = body['context'] as Map<String, dynamic>;
  for (final field in bodyRules['required'] as List) {
    expect(body, contains(field));
  }
  for (final field in body.keys) {
    expect(fields(bodyRules), contains(field));
  }
  for (final field in (rules['session'] as Map)['required'] as List) {
    expect(body['session'], contains(field));
  }
  for (final field in contextRules['required'] as List) {
    expect(context, contains(field));
  }
  for (final field in context.keys) {
    expect(fields(contextRules), contains(field));
  }
  expect(rules['platforms'], contains(context['platform']));
  expect(rules['device_types'], contains(context['device_type']));
  expect(body['sent_at'], matches(RegExp(rules['time'] as String)));
  for (final event in body['events'] as List) {
    final map = event as Map<String, dynamic>;
    for (final field in eventRules['required'] as List) {
      expect(map, contains(field));
    }
    for (final field in map.keys) {
      expect(fields(eventRules), contains(field));
    }
    expect(map['name'], matches(RegExp(rules['event_name'] as String)));
    expect(map['time'], matches(RegExp(rules['time'] as String)));
  }
}

void main() {
  group('Flutter client', () {
    test('records the install, the open, screens and events, and sends them on backgrounding', () {
      run((h) {
        final client = h.start(MemoryStorage());
        h.async.flushMicrotasks();
        client.foreground();
        client.screen('Home');
        h.settle(1000);
        client.screen('Lesson');
        client.track('lesson_completed', {'lesson': 3});
        h.settle(63000);
        client.background();
        h.settle();

        expect(names(h.sent), [
          'session_started',
          'app_installed',
          'app_opened',
          'screen_viewed',
          'screen_viewed',
          'lesson_completed',
          'app_backgrounded',
        ]);
        final events = eventsOf(h.sent);
        expect(events[1]['properties'], {'version': '2.4.0', 'build': '120'});
        expect(events[2]['properties'], {'from_background': false});
        expect(events[4]['screen'], 'Lesson');
        expect(events[4]['properties'], {'name': 'Lesson', 'previous': 'Home'});
        expect(events[5]['screen'], 'Lesson');
        expect(events[5]['properties'], {'lesson': 3});
        expect(events[6]['properties'], {'seconds_in_foreground': 64});
        for (final body in h.sent) {
          expectContract(body);
          expect((body['session'] as Map)['id'], client.sessionId);
          expect(body['context'], {
            'platform': 'ios',
            'sdk': 'kma-flutter/1.0.0',
            'timezone': 'Africa/Lagos',
            'language': 'en-NG',
            'device_type': 'mobile',
            'device_model': 'iPhone15,4',
            'os_name': 'iOS',
            'os_version': '18.1',
            'app_version': '2.4.0',
            'screen_width': 393,
            'screen_height': 852,
            'page_path': 'Home',
          });
        }
      });
    });

    test('tells an update from an install, and keeps the person and a recent session', () {
      run((h) {
        final storage = MemoryStorage();
        final first = h.start(storage);
        first.foreground();
        h.settle();
        first.background();
        h.settle();
        final person = first.anonymousId;
        final session = first.sessionId;
        first.shutdown();
        h.sent.clear();

        h.clock += minutes(5);
        final second = h.start(storage, appVersion: '2.5.0', build: '130');
        second.foreground();
        h.settle(10000);
        expect(names(h.sent), ['app_updated', 'app_opened']);
        expect(eventsOf(h.sent).first['properties'], {
          'version': '2.5.0',
          'build': '130',
          'previous_version': '2.4.0',
          'previous_build': '120',
        });
        expect(second.anonymousId, person);
        expect(second.sessionId, session);
      });
    });

    test('starts a new session after 30 minutes away', () {
      run((h) {
        final client = h.start(MemoryStorage());
        client.foreground();
        h.settle();
        final first = client.sessionId;
        client.background();
        h.settle();
        h.sent.clear();

        h.clock += minutes(10);
        client.foreground();
        h.settle(10000);
        expect(names(h.sent), ['app_opened']);
        expect(eventsOf(h.sent).first['properties'], {'from_background': true});
        expect(client.sessionId, first);
        client.background();
        h.settle();
        h.sent.clear();

        h.clock += minutes(31);
        client.foreground();
        h.settle(10000);
        expect(names(h.sent), ['session_started', 'app_opened']);
        expect(client.sessionId, isNot(first));
      });
    });

    test('keeps events offline, retries, and sends them on a later launch', () {
      run((h) {
        final storage = MemoryStorage();
        h.answer = () async => throw const SocketException('offline');
        final client = h.start(storage, maxQueue: 4);
        client.foreground();
        for (final lesson in [1, 2, 3]) {
          client.track('lesson_completed', {'lesson': lesson});
        }
        client.background();
        h.settle(2000);
        expect(h.sent, isNotEmpty);
        client.shutdown();

        // Only the newest four were kept.
        h.sent.clear();
        h.answer = Harness.ok;
        final later = h.start(storage);
        h.settle(100);
        final delivered = eventsOf(h.sent);
        expect(delivered.map((event) => event['name']), [
          'lesson_completed',
          'lesson_completed',
          'lesson_completed',
          'app_backgrounded',
        ]);
        expect(
          delivered.map((event) => (event['properties'] as Map)['lesson']),
          [1, 2, 3, null],
        );
        expect(later.anonymousId, client.anonymousId);
      });
    });

    test('drops a batch the server refuses but retries when it is busy', () {
      run((h) {
        final client = h.start(MemoryStorage());
        h.answer = () async => const KmaResponse(503, 'busy');
        client.foreground();
        h.settle(10000);
        expect(h.sent, hasLength(1));
        h.answer = Harness.ok;
        h.settle(2000);
        expect(h.sent, hasLength(2));
        List<Object?> ids(Body body) =>
            [for (final event in body['events'] as List) (event as Map)['insert_id']];
        expect(ids(h.sent[1]), ids(h.sent[0]));

        h.answer = () async => const KmaResponse(400, 'bad');
        client.track('broken_event');
        h.settle(10000);
        h.answer = Harness.ok;
        h.settle(60000);
        expect(names(h.sent.sublist(2)), ['broken_event']);
      });
    });

    test('names the person once identified, and starts someone new on reset', () {
      run((h) {
        final client = h.start(MemoryStorage());
        client.foreground();
        client.identify('user-42', {'email': 'amaka@example.com', 'plan': 'annual'});
        h.settle();
        expect(h.sent[0]['user_id'], 'user-42');
        expect(h.sent[0]['traits'], {'email': 'amaka@example.com', 'plan': 'annual'});
        client.track('plan_selected');
        h.settle(10000);
        expect(h.sent[1]['user_id'], 'user-42');
        expect(h.sent[1].containsKey('traits'), isFalse);

        final before = client.anonymousId;
        client.track('signed_out');
        client.reset();
        client.track('browsed');
        h.settle(10000);
        final after = h.sent.sublist(2);
        expect(after[0]['anonymous_id'], before);
        expect(after[0]['user_id'], 'user-42');
        expect(names([after[0]]), ['signed_out']);
        expect(after[1]['anonymous_id'], isNot(before));
        expect(after[1].containsKey('user_id'), isFalse);
        expect(names([after[1]]), ['session_started', 'browsed']);
      });
    });

    test('stays quiet after opting out, across launches, until opting in', () {
      run((h) {
        final storage = MemoryStorage();
        final client = h.start(storage);
        client.optOut();
        client.foreground();
        client.track('hidden');
        h.settle(10000);
        expect(h.sent, isEmpty);
        client.shutdown();

        final next = h.start(storage);
        next.foreground();
        next.track('still_hidden');
        h.settle(10000);
        expect(h.sent, isEmpty);
        next.optIn();
        next.track('visible');
        h.settle(10000);
        expect(names(h.sent), ['session_started', 'visible']);
      });
    });

    test('keeps calls made before saved state has loaded', () {
      run((h) {
        final loaded = Completer<void>();
        final client = h.start(_SlowStorage(loaded.future));
        client.foreground();
        client.screen('Welcome');
        client.track('tapped_start');
        h.settle();
        expect(h.sent, isEmpty);
        loaded.complete();
        h.settle(10000);
        expect(names(h.sent), [
          'session_started',
          'app_installed',
          'app_opened',
          'screen_viewed',
          'tapped_start',
        ]);
      });
    });

    test('keeps an open app online with a heartbeat', () {
      run((h) {
        final client = h.start(MemoryStorage());
        client.foreground();
        h.settle(10000);
        h.sent.clear();
        h.settle(60000);
        expect(h.sent, hasLength(1));
        expect(h.sent[0]['events'], isEmpty);
        expect((h.sent[0]['session'] as Map)['id'], client.sessionId);
        client.background();
        h.settle();
        h.sent.clear();
        h.settle(120000);
        expect(h.sent, isEmpty);
      });
    });

    test('refuses a server key and ignores bad event names', () {
      run((h) {
        expect(
          () => h.start(null, clientKey: 'kma_sk_live_ABCDEFGHJKLMNPQRSTUVWXYZ'),
          throwsA(isA<ArgumentError>().having(
            (error) => error.message,
            'message',
            allOf(contains('kma_pk_'), isNot(contains('ABCDEFGH'))),
          )),
        );
        final client = h.start(null, trackLifecycle: false);
        client.foreground();
        client.track('not valid!');
        client.track('valid_name');
        h.settle(10000);
        expect(names(h.sent), ['session_started', 'valid_name']);
      });
    });
  });

  group('Dart specifics', () {
    test('turns dates, enums and sets into JSON, and drops properties over 32 KB', () {
      run((h) {
        final client = h.start(null, trackLifecycle: false);
        client.foreground();
        client.track('typed', {
          'at': DateTime.utc(2026, 10, 30, 10),
          'kind': _Plan.annual,
          'tags': {'a', 'b'},
          'nested': {'n': 1.5, 'ok': true, 'none': null},
          'nan': double.nan,
        });
        client.track('huge', {'text': 'x' * 33000});
        h.settle(10000);
        final events = eventsOf(h.sent);
        expect(events[1]['properties'], {
          'at': '2026-10-30T10:00:00.000Z',
          'kind': 'annual',
          'tags': ['a', 'b'],
          'nested': {'n': 1.5, 'ok': true, 'none': null},
          'nan': null,
        });
        expect(events[2]['name'], 'huge');
        expect(events[2]['properties'], isEmpty);
      });
    });

    test('sends one session and one person per request, 50 events at most', () {
      run((h) {
        final client = h.start(null, trackLifecycle: false);
        h.async.flushMicrotasks();
        client.foreground();
        for (var i = 0; i < 29; i++) {
          client.track('tap', {'i': i});
        }
        h.clock += minutes(31);
        client.track('later');
        h.settle();
        expect(h.sent, hasLength(2));
        expect((h.sent[0]['events'] as List), hasLength(30));
        expect(names([h.sent[1]]), ['session_started', 'later']);
        expect(
          (h.sent[0]['session'] as Map)['id'],
          isNot((h.sent[1]['session'] as Map)['id']),
        );

        h.sent.clear();
        h.answer = () async => const KmaResponse(503);
        for (var i = 0; i < 60; i++) {
          client.track('tap');
        }
        h.settle();
        h.answer = Harness.ok;
        h.settle(2000);
        expect(h.sent.map((body) => (body['events'] as List).length), [50, 50, 10]);
      });
    });

    test('lets the platform know once the background send is over', () {
      run((h) {
        final client = h.start(MemoryStorage());
        client.foreground();
        h.settle(10000);
        var done = false;
        h.answer = () => Future.delayed(const Duration(seconds: 2), Harness.ok);
        unawaited(client.background().then((_) => done = true));
        h.async.elapse(const Duration(seconds: 1));
        expect(done, isFalse);
        h.async.elapse(const Duration(seconds: 2));
        expect(done, isTrue);
        expect(names([h.sent.last]), ['app_backgrounded']);
      });
    });

    test('waits for the first background send when told twice, as iOS does', () {
      run((h) {
        final client = h.start(MemoryStorage());
        client.foreground();
        h.settle(10000);
        final done = <String>[];
        h.answer = () => Future.delayed(const Duration(seconds: 2), Harness.ok);
        unawaited(client.background().then((_) => done.add('hidden')));
        unawaited(client.background().then((_) => done.add('paused')));
        h.async.elapse(const Duration(seconds: 1));
        expect(done, isEmpty);
        h.async.elapse(const Duration(seconds: 2));
        expect(done, ['hidden', 'paused']);

        client.foreground();
        h.settle(10000);
        h.sent.clear();
        unawaited(client.background());
        h.settle(3000);
        expect(names(h.sent), ['app_backgrounded']);
      });
    });

    test('gives up on traits the server refuses instead of sending them forever', () {
      run((h) {
        final client = h.start(null, trackLifecycle: false);
        client.foreground();
        h.settle(10000);
        h.sent.clear();
        h.answer = () async => const KmaResponse(422, 'traits too large');
        client.setTraits({'plan': 'annual'});
        h.settle(60000);
        expect(h.sent, hasLength(1));
      });
    });

    test('keeps state in files that survive a restart', () async {
      final directory = await Directory.systemTemp.createTemp('kissmyapps');
      addTearDown(() => directory.delete(recursive: true));
      final storage = FileStorage('${directory.path}/nested');
      expect(await storage.read('kma_test'), isNull);
      await Future.wait([
        storage.write('kma_test', '{"n":1}'),
        storage.write('kma_test', '{"n":2}'),
      ]);
      expect(await FileStorage('${directory.path}/nested').read('kma_test'), '{"n":2}');
      expect(
        Directory('${directory.path}/nested').listSync().map((file) => file.uri.pathSegments.last),
        ['kma_test.json'],
      );
    });
  });
}

enum _Plan { annual }

class _SlowStorage implements KmaStorage {
  _SlowStorage(this.loaded);

  final Future<void> loaded;

  @override
  Future<String?> read(String name) async {
    await loaded;
    return null;
  }

  @override
  Future<void> write(String name, String value) async {}
}
