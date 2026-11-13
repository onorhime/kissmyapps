// The same cases as the React Native client's tests, so every app SDK behaves alike, plus
// the parts that are Dart's own. Each request is checked against ../contract.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kissmyapps/src/attribution.dart';
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

/// One attribution call: its path and body.
typedef Call = ({String path, Body body});

/// One test's clock, network and clients, driven by fake time.
class Harness {
  Harness(this.async);

  final FakeAsync async;
  int clock = DateTime.utc(2026, 10, 30, 9, 59).millisecondsSinceEpoch;
  final List<Body> sent = [];
  Future<KmaResponse> Function() answer = ok;
  final List<KmaClient> clients = [];

  /// The attribution calls, kept apart from event batches.
  final List<Call> calls = [];
  Future<KmaResponse> Function(Call call) attributionAnswer = (_) => organic();
  final List<String> unexpected = [];

  static Future<KmaResponse> ok() async => const KmaResponse(200, '{}');

  static Future<KmaResponse> organic() async =>
      const KmaResponse(200, '{"matched":false,"method":"organic","deep_link":null}');

  List<Body> get installs => [
        for (final call in calls)
          if (call.path == '/v1/attribution/install') call.body,
      ];

  List<Body> get opens => [
        for (final call in calls)
          if (call.path == '/v1/attribution/open') call.body,
      ];

  KmaClient start(
    KmaStorage? storage, {
    String clientKey = key,
    String appVersion = '2.4.0',
    String build = '120',
    int maxQueue = 1000,
    bool trackLifecycle = true,
    bool attribution = true,
    bool clipboardHandoff = false,
    KmaDevice device = iphone,
    KmaAttributionReader? native,
    Future<String?> Function()? initialLink,
  }) {
    final client = KmaClient(
      clientKey,
      KissMyAppsOptions(
        appVersion: appVersion,
        build: build,
        maxQueue: maxQueue,
        trackLifecycle: trackLifecycle,
        attribution: attribution,
        clipboardHandoff: clipboardHandoff,
      ),
      KmaEnvironment(
        storage: storage,
        device: () => device,
        sdk: 'kma-flutter/$sdkVersion',
        now: () => clock,
        attributionInfo: native,
        initialLink: initialLink,
        post: (url, headers, body) {
          expect(headers['authorization'], 'Bearer $key');
          expect(headers['content-type'], 'application/json');
          final path = url.toString().replaceFirst('https://events.kissmyapps.dev', '');
          if (path == '/v1/events') {
            sent.add(jsonDecode(body) as Body);
            return answer();
          }
          // An expect here would be caught by the client as a failed request.
          if (path != installPath && path != openPath) unexpected.add(path);
          final call = (path: path, body: jsonDecode(body) as Body);
          calls.add(call);
          return attributionAnswer(call);
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
    expect(unexpected, isEmpty);
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

final Map<String, dynamic> attributionRules = contract['attribution'] as Map<String, dynamic>;

/// The longest a field may be, from its rule's words ("at most 2048 characters").
int longest(Object? rule) {
  final match = RegExp(r'at most (\d+) characters').firstMatch('$rule');
  if (match == null) throw StateError('No length in: $rule');
  return int.parse(match.group(1)!);
}

/// The rules for both attribution calls, from the contract's attribution section.
void expectAttributionContract(String kind, Map<String, dynamic> body) {
  final call = attributionRules[kind] as Map<String, dynamic>;
  final rules = attributionRules['fields'] as Map<String, dynamic>;
  for (final field in call['required'] as List) {
    expect(body, contains(field));
  }
  for (final field in body.keys) {
    expect(fields(call), contains(field));
  }
  expect(rules['platform'], contains(body['platform']));
  expect(body['anonymous_id'], isA<String>());
  expect(body['session_id'], isA<String>());
  expect(body['sdk'], matches(RegExp(r'^kma-[a-z-]+/\d+\.\d+\.\d+$')));
  for (final name in ['installed_at', 'opened_at', 'device_key', 'clipboard_click']) {
    if (body.containsKey(name)) expect(body[name], matches(RegExp(rules[name] as String)));
  }
  for (final link in ['link_url', 'url']) {
    if (!body.containsKey(link)) continue;
    expect(body[link], startsWith('https://'));
    expect((body[link] as String).length, lessThanOrEqualTo(longest(rules[link])));
  }
  for (final name in ['referrer', 'apple_ads_token']) {
    if (body.containsKey(name)) {
      expect((body[name] as String).length, lessThanOrEqualTo(longest(rules[name])));
    }
  }
  for (final stamp in ['referrer_click_ts', 'install_begin_ts']) {
    if (body.containsKey(stamp)) expect(body[stamp], isA<int>());
  }
  // Android only, and iOS only.
  for (final name in ['referrer', 'referrer_click_ts', 'install_begin_ts']) {
    if (body.containsKey(name)) expect(body['platform'], 'android');
  }
  for (final name in ['apple_ads_token', 'clipboard_click']) {
    if (body.containsKey(name)) expect(body['platform'], 'ios');
  }
}

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
const deviceKey = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const playInfo = KmaAttributionInfo(
  deviceKey: deviceKey,
  referrer: 'kma_lc=Q2xpY2tJZDAwMDAwMDAwMQ&utm_source=tiktok&utm_campaign=launch',
  referrerClickTs: 1761818300,
  installBeginTs: 1761818320,
);

Future<KmaResponse> Function(Call) reply(Object? answer, [int status = 200]) =>
    (_) async => KmaResponse(status, jsonEncode(answer));

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
            'sdk': 'kma-flutter/1.1.0',
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
        // The install call sends what is queued at once; this test times the batches itself.
        final client = h.start(MemoryStorage(), attribution: false);
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
  group('Install attribution and deep links', () {
    final examples = attributionRules['examples'] as Map<String, dynamic>;
    final response = examples['response'] as Map<String, dynamic>;
    const deferredLink = KissMyAppsDeepLink(value: 'lesson', params: {'id': '4'}, deferred: true);

    test('matches the contract and its examples', () {
      final install = examples['install'] as Map<String, dynamic>;
      final open = examples['open'] as Map<String, dynamic>;
      expectAttributionContract('install', install);
      expectAttributionContract('open', open);
      expect(
        installBody(
          anonymousId: install['anonymous_id'] as String,
          sessionId: install['session_id'] as String,
          platform: 'android',
          installedAt: DateTime.parse(install['installed_at'] as String).millisecondsSinceEpoch,
          sdk: install['sdk'] as String,
          appVersion: install['app_version'] as String,
          info: playInfo,
          clipboard: false,
        ),
        {...install, 'referrer': playInfo.referrer},
      );
      expect(
        openBody(
          anonymousId: open['anonymous_id'] as String,
          sessionId: open['session_id'] as String,
          platform: 'ios',
          url: open['url'] as String,
          openedAt: DateTime.parse(open['opened_at'] as String).millisecondsSinceEpoch,
          sdk: open['sdk'] as String,
          userId: open['user_id'] as String,
        ),
        open,
      );
      final answer = attributionRules['response'] as Map<String, dynamic>;
      for (final field in answer['required'] as List) {
        expect(response, contains(field));
      }
      expect(answer['methods'], contains(response['method']));
      expect(deepLinkFrom(response, null), deferredLink);
      expect(deepLinkFrom({'matched': false, 'method': 'off', 'deep_link': null}, null), isNull);
    });

    test(
        'calls install once after app_installed, with the Play referrer, and hands over the '
        'deep link once', () {
      run((h) {
        final storage = MemoryStorage();
        final asked = <String>[];
        h.attributionAnswer = reply(response);
        final client = h.start(
          storage,
          device: pixel,
          native: ({required install, required clipboard}) async {
            asked.add('install: $install, clipboard: $clipboard');
            return playInfo;
          },
        );
        final links = <KissMyAppsDeepLink>[];
        client.onDeepLink(links.add);
        client.foreground();
        h.settle();

        // app_installed and its session went first.
        expect(names(h.sent), ['session_started', 'app_installed', 'app_opened']);
        expect(h.installs, hasLength(1));
        expect(h.opens, isEmpty);
        expect(asked, ['install: true, clipboard: false']);
        final body = h.installs.single;
        expectAttributionContract('install', body);
        expect(body, {
          'anonymous_id': client.anonymousId,
          'session_id': client.sessionId,
          'platform': 'android',
          'installed_at': '2026-10-30T09:59:00.000Z',
          'sdk': 'kma-flutter/1.1.0',
          'app_version': '2.4.0',
          'device_key': deviceKey,
          'referrer': playInfo.referrer,
          'referrer_click_ts': 1761818300,
          'install_begin_ts': 1761818320,
        });
        expect(links, [deferredLink]);

        // Later launches make no install call, and the deep link is not handed over again.
        unawaited(client.background());
        h.settle();
        client.shutdown();
        final next = h.start(storage,
            device: pixel, native: ({required install, required clipboard}) async => playInfo);
        next.onDeepLink(links.add);
        next.foreground();
        h.settle(10000);
        expect(h.installs, hasLength(1));
        expect(links, hasLength(1));
      });
    });

    test('sends the Apple Ads token on iPhone, and the clipboard click only when handoff is on',
        () {
      run((h) {
        final asked = <bool>[];
        final iosInfo = KmaAttributionInfo(
          deviceKey: deviceKey,
          appleAdsToken: 'A' * 200,
          clipboardClick: 'Q2xpY2tJZDAwMDAwMDAwMQ',
          referrer: 'never sent from an iPhone',
        );
        Future<KmaAttributionInfo?> native({required bool install, required bool clipboard}) async {
          asked.add(clipboard);
          return iosInfo;
        }

        h.start(MemoryStorage(), native: native).foreground();
        h.settle();
        h.start(MemoryStorage(), native: native, clipboardHandoff: true).foreground();
        h.settle();

        expect(asked, [false, true]);
        final [first, second] = h.installs;
        expectAttributionContract('install', first);
        expectAttributionContract('install', second);
        expect(first['platform'], 'ios');
        expect(first['apple_ads_token'], 'A' * 200);
        expect(first, isNot(contains('clipboard_click')));
        expect(first, isNot(contains('referrer')));
        expect(second['clipboard_click'], 'Q2xpY2tJZDAwMDAwMDAwMQ');
      });
    });

    test('leaves out what the device gives that the contract does not allow', () {
      run((h) {
        h
            .start(
              MemoryStorage(),
              clipboardHandoff: true,
              native: ({required install, required clipboard}) async => KmaAttributionInfo(
                deviceKey: 'NOT-A-HASH',
                appleAdsToken: 'A' * 5000,
                clipboardClick: 'too short',
              ),
            )
            .foreground();
        h.settle();
        final body = h.installs.single;
        expectAttributionContract('install', body);
        expect(body.keys.toList()..sort(), [
          'anonymous_id',
          'app_version',
          'installed_at',
          'platform',
          'sdk',
          'session_id',
        ]);
      });
    });

    test('still calls install without the plugin, and when it fails or never answers', () {
      run((h) {
        h.start(MemoryStorage()).foreground();
        h.settle();
        h
            .start(
              MemoryStorage(),
              native: ({required install, required clipboard}) async =>
                  throw StateError('no referrer service'),
            )
            .foreground();
        h.settle();
        h
            .start(
              MemoryStorage(),
              native: ({required install, required clipboard}) =>
                  Completer<KmaAttributionInfo?>().future,
            )
            .foreground();
        h.settle(12000);
        expect(h.installs, hasLength(3));
        for (final body in h.installs) {
          expectAttributionContract('install', body);
        }
      });
    });

    test(
        'tries again on the next launches when offline, three times at most, with the first '
        "launch's details", () {
      run((h) {
        final storage = MemoryStorage();
        h.attributionAnswer = (_) async => throw const SocketException('offline');
        var client = h.start(storage, device: pixel);
        client.foreground();
        h.settle();
        final person = client.anonymousId;
        final session = client.sessionId;
        for (var launch = 2; launch <= 6; launch += 1) {
          unawaited(client.background());
          h.settle();
          client.shutdown();
          h.clock += minutes(60);
          client = h.start(storage, device: pixel);
          client.foreground();
          h.settle();
        }
        expect(h.installs, hasLength(4));
        for (final body in h.installs) {
          expectAttributionContract('install', body);
          expect(body['anonymous_id'], person);
          expect(body['session_id'], session);
          expect(body['installed_at'], '2026-10-30T09:59:00.000Z');
        }
      });
    });

    test(
        'resends the first try as it was, reading again only a referrer that timed out and '
        'the Apple Ads token each time', () {
      run((h) {
        Future<KmaResponse> offline(Call _) async => throw const SocketException('offline');
        h.attributionAnswer = offline;
        final storage = MemoryStorage();
        var launch = 1;
        KmaClient android() => h.start(
              storage,
              device: pixel,
              native: ({required install, required clipboard}) async => KmaAttributionInfo(
                deviceKey: deviceKey,
                referrer: 'kma_lc=FirstClickId0000001-$launch',
              ),
            );
        var client = android()..foreground();
        h.settle();
        client.shutdown();
        launch = 2;
        client = android()..foreground();
        h.settle();
        client.shutdown();
        expect(h.installs.map((body) => body['referrer']), [
          'kma_lc=FirstClickId0000001-1',
          'kma_lc=FirstClickId0000001-1',
        ]);

        // Google Play did not answer in time on the first launch: the next one asks again.
        h.calls.clear();
        final slow = MemoryStorage();
        var answer = const KmaAttributionInfo(deviceKey: deviceKey, retryReferrer: true);
        KmaClient late() => h.start(
              slow,
              device: pixel,
              native: ({required install, required clipboard}) async => answer,
            );
        client = late()..foreground();
        h.settle();
        client.shutdown();
        answer = playInfo;
        client = late()..foreground();
        h.settle();
        client.shutdown();
        expect(h.installs.map((body) => body['referrer']), [null, playInfo.referrer]);

        // On iPhone the token is fetched for each try (it expires); the clipboard is read once.
        h.calls.clear();
        final phone = MemoryStorage();
        final asked = <bool>[];
        var adsAnswer = 'ads-1';
        KmaClient ios() => h.start(
              phone,
              clipboardHandoff: true,
              native: ({required install, required clipboard}) async {
                asked.add(clipboard);
                return KmaAttributionInfo(
                  deviceKey: deviceKey,
                  appleAdsToken: adsAnswer,
                  clipboardClick: clipboard ? 'Q2xpY2tJZDAwMDAwMDAwMQ' : null,
                );
              },
            );
        client = ios()..foreground();
        h.settle();
        client.shutdown();
        adsAnswer = 'ads-2';
        client = ios()..foreground();
        h.settle();
        expect(asked, [true, false]);
        expect(h.installs.map((body) => [body['apple_ads_token'], body['clipboard_click']]), [
          ['ads-1', 'Q2xpY2tJZDAwMDAwMDAwMQ'],
          ['ads-2', 'Q2xpY2tJZDAwMDAwMDAwMQ'],
        ]);
      });
    });

    test('cuts a long referrer to 1,024 characters and leaves out unknown Play times', () {
      run((h) {
        h
            .start(
              MemoryStorage(),
              device: pixel,
              native: ({required install, required clipboard}) async => KmaAttributionInfo(
                referrer: 'r' * 1500,
                referrerClickTs: 0,
                installBeginTs: 0,
              ),
            )
            .foreground();
        h.settle();
        final body = h.installs.single;
        expectAttributionContract('install', body);
        expect(body['referrer'], 'r' * 1024);
        expect(body, isNot(contains('referrer_click_ts')));
        expect(body, isNot(contains('install_begin_ts')));
      });
    });

    test(
        'calls install with lifecycle tracking off, and holds it back while opted out until '
        'optIn', () {
      run((h) {
        h.start(MemoryStorage(), trackLifecycle: false).foreground();
        h.settle();
        expect(h.installs, hasLength(1));

        h.calls.clear();
        final slow = Completer<KmaAttributionInfo?>();
        final client = h.start(
          MemoryStorage(),
          native: ({required install, required clipboard}) => slow.future,
        )..foreground();
        h.settle();
        client.optOut();
        slow.complete(const KmaAttributionInfo(deviceKey: deviceKey));
        h.settle();
        expect(h.calls, isEmpty);
        client.optIn();
        h.settle();
        expect(h.installs.single['device_key'], deviceKey);
      });
    });

    test(
        'sends links that came while the install call was out once it is answered, and not '
        'before', () {
      run((h) {
        final answered = Completer<KmaResponse>();
        h.attributionAnswer =
            (call) => call.path == installPath ? answered.future : Harness.organic();
        final client = h.start(MemoryStorage())..foreground();
        client.handleDeepLink('https://fluent.go.kissmyapps.dev/first');
        client.handleDeepLink('https://fluent.go.kissmyapps.dev/second');
        h.settle();
        client.handleDeepLink('https://fluent.go.kissmyapps.dev/third');
        h.settle();
        expect(h.calls.map((call) => call.path), [installPath]);
        expect(h.installs.single['link_url'], 'https://fluent.go.kissmyapps.dev/first');
        answered.complete(const KmaResponse(200, '{"matched":false,"method":"organic"}'));
        h.settle();
        expect(h.opens.map((body) => body['url']), [
          'https://fluent.go.kissmyapps.dev/second',
          'https://fluent.go.kissmyapps.dev/third',
        ]);
      });
    });

    test(
        'on a retry launch, sends a link to open only after the install is answered, never in '
        'link_url', () {
      run((h) {
        final storage = MemoryStorage();
        h.attributionAnswer = (_) async => throw const SocketException('offline');
        var client = h.start(storage)..foreground();
        h.settle();
        client.shutdown();

        // Still offline: the link is not sent, or the open would record an install first.
        client = h.start(storage, initialLink: () async => 'https://fluent.go.kissmyapps.dev/again')
          ..foreground();
        h.settle();
        client.handleDeepLink('https://fluent.go.kissmyapps.dev/later');
        h.settle();
        expect(h.calls.map((call) => call.path), [installPath, installPath]);
        client.shutdown();

        h.attributionAnswer = (_) => Harness.organic();
        client = h.start(
          storage,
          initialLink: () async => 'https://fluent.go.kissmyapps.dev/third-launch',
        )..foreground();
        h.settle();
        expect(h.calls.map((call) => call.path), [installPath, installPath, installPath, openPath]);
        for (final body in h.installs) {
          expect(body, isNot(contains('link_url')));
        }
        expect(h.opens.single['url'], 'https://fluent.go.kissmyapps.dev/third-launch');
      });
    });

    test('reads at most 10 deep link parameters, as text', () {
      final link = deepLinkFrom({
        'matched': true,
        'method': 'some_new_method',
        'deep_link': {
          'value': null,
          'params': {
            'on': true,
            'list': [1],
            for (var index = 0; index < 12; index += 1) 'p$index': index,
          },
          'deferred': false,
        },
      }, null)!;
      expect(link.params['on'], 'true');
      expect(link.params, isNot(contains('list')));
      expect(link.params, hasLength(10));
      expect(link.value, isNull);
    });

    test('stops trying once the server answers, and does not retry a refused body', () {
      run((h) {
        final storage = MemoryStorage();
        h.attributionAnswer = reply({'error': 'busy'}, 503);
        for (var launch = 1; launch <= 3; launch += 1) {
          final client = h.start(storage)..foreground();
          h.settle();
          client.shutdown();
          h.attributionAnswer = (_) => Harness.organic();
        }
        expect(h.installs, hasLength(2));

        final refused = MemoryStorage();
        h.attributionAnswer = reply({'error': 'invalid_body'}, 400);
        for (var launch = 1; launch <= 2; launch += 1) {
          final client = h.start(refused)..foreground();
          h.settle();
          client.shutdown();
        }
        expect(h.installs, hasLength(3));
      });
    });

    test('sends the opening link with the install, and later links to open', () {
      run((h) {
        const opening = 'https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4';
        const promo = 'https://fluent.go.kissmyapps.dev/promo';
        h.attributionAnswer = (call) async => KmaResponse(
              200,
              jsonEncode({
                'matched': true,
                'method': 'link_open',
                'deep_link': call.path == installPath
                    ? {
                        'value': 'lesson',
                        'params': {'id': '4'},
                        'deferred': true,
                      }
                    : {
                        'value': 'promo',
                        'params': {'code': 7},
                        'deferred': false,
                      },
              }),
            );
        final client = h.start(MemoryStorage(), initialLink: () async => opening);
        final links = <KissMyAppsDeepLink>[];
        client.onDeepLink(links.add);
        client.foreground();
        // The app reports the same link too: it counts once.
        expect(client.handleDeepLink(opening), isTrue);
        h.settle();
        expect(h.opens, isEmpty);
        expect(h.installs.single['link_url'], opening);

        h.clock += 5000;
        client.identify('user-42');
        expect(client.handleDeepLink(promo), isTrue);
        h.settle();
        final body = h.opens.single;
        expectAttributionContract('open', body);
        expect(body, {
          'anonymous_id': client.anonymousId,
          'session_id': client.sessionId,
          'platform': 'ios',
          'url': promo,
          'opened_at': '2026-10-30T09:59:05.000Z',
          'sdk': 'kma-flutter/1.1.0',
          'user_id': 'user-42',
          'app_version': '2.4.0',
        });
        expect(links, [
          KissMyAppsDeepLink(
            value: 'lesson',
            params: const {'id': '4'},
            deferred: true,
            url: Uri.parse(opening),
          ),
          KissMyAppsDeepLink(
            value: 'promo',
            params: const {'code': '7'},
            deferred: false,
            url: Uri.parse(promo),
          ),
        ]);
      });
    });

    test('keeps a link that came before the launch for the install call', () {
      run((h) {
        final client = h.start(MemoryStorage());
        expect(client.handleDeepLink('https://fluent.go.kissmyapps.dev/lesson-4'), isTrue);
        h.settle();
        expect(h.calls, isEmpty);
        client.foreground();
        h.settle();
        expect(h.calls.map((call) => call.path), [installPath]);
        expect(h.installs.single['link_url'], 'https://fluent.go.kissmyapps.dev/lesson-4');
      });
    });

    test('holds a deep link until a handler is set, and hands it over once', () {
      run((h) {
        h.attributionAnswer = reply(response);
        final client = h.start(MemoryStorage())..foreground();
        h.settle();
        final first = <KissMyAppsDeepLink>[];
        final second = <KissMyAppsDeepLink>[];
        client.onDeepLink(first.add);
        h.settle();
        client.onDeepLink(second.add);
        h.settle();
        expect(first, [deferredLink]);
        expect(second, isEmpty);

        // A handler that throws does not stop the SDK.
        client.onDeepLink((_) => throw StateError('navigator not ready'));
        h.attributionAnswer = reply({'matched': true, 'method': 'link_open', 'deep_link': null});
        client.handleDeepLink('https://fluent.go.kissmyapps.dev/nothing');
        h.settle();
        expect(h.opens, hasLength(1));
      });
    });

    test('sends nothing for other links, when opted out, or with attribution off', () {
      run((h) {
        final client = h.start(MemoryStorage(), initialLink: () async => 'fluent://lesson/4')
          ..foreground();
        h.settle();
        expect(client.handleDeepLink('fluent://lesson/4'), isFalse);
        expect(client.handleDeepLink('http://fluent.go.kissmyapps.dev/a'), isFalse);
        expect(client.handleDeepLink('https://fluent.go.kissmyapps.dev/${'a' * 2048}'), isFalse);
        client.optOut();
        h.settle();
        expect(client.handleDeepLink('https://fluent.go.kissmyapps.dev/a'), isFalse);
        h.settle();
        expect(h.calls.map((call) => call.path), [installPath]);
        expect(h.installs.single, isNot(contains('link_url')));

        h.calls.clear();
        final off = h.start(
          MemoryStorage(),
          attribution: false,
          initialLink: () async => 'https://fluent.go.kissmyapps.dev/a',
        )..foreground();
        expect(off.handleDeepLink('https://fluent.go.kissmyapps.dev/b'), isFalse);
        h.settle();
        expect(h.calls, isEmpty);

        // Without storage every launch looks like the first: there is no install to match.
        h.start(null).foreground();
        h.settle();
        expect(h.calls, isEmpty);
      });
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
