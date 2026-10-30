import Foundation
import XCTest
@testable import KissMyApps

private let key = "kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ"
private func minutes(_ count: Int64) -> Int64 { count * 60_000 }

/// A clock and timers the test moves forward by hand. Tasks run on the test's thread.
final class ManualScheduler: Scheduler {
    private final class Task {
        let due: Int64
        let order: Int
        let run: () -> Void
        init(due: Int64, order: Int, run: @escaping () -> Void) {
            self.due = due
            self.order = order
            self.run = run
        }
    }

    var now: Int64 = 1_793_354_340_000 // 2026-10-30T09:59:00Z
    private var tasks: [Task] = []
    private var order = 0

    func execute(_ task: @escaping () -> Void) {
        task()
    }

    func schedule(after milliseconds: Int64, _ task: @escaping () -> Void) -> Cancellable {
        let scheduled = Task(due: now + milliseconds, order: order, run: task)
        order += 1
        tasks.append(scheduled)
        return BlockCancellable { [weak self] in self?.tasks.removeAll { $0 === scheduled } }
    }

    func advance(_ milliseconds: Int64) {
        let end = now + milliseconds
        while let next = tasks.filter({ $0.due <= end }).min(by: { ($0.due, $0.order) < ($1.due, $1.order) }) {
            tasks.removeAll { $0 === next }
            now = max(now, next.due)
            next.run()
        }
        now = end
    }
}

final class MemoryStore: Store {
    var data: [String: String] = [:]
    func read(_ name: String) -> String? { data[name] }
    func write(_ name: String, _ value: String) { data[name] = value }
}

let iphone = DeviceInfo(
    platform: "ios",
    osName: "iOS",
    osVersion: "18.1",
    deviceType: "mobile",
    deviceModel: "iPhone15,4",
    screenWidth: 393,
    screenHeight: 852,
    timezone: "Africa/Lagos",
    language: "en-NG"
)

private let contract: [String: Any] = {
    let url = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // KissMyAppsTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // analytics-mobile
        .appendingPathComponent("contract/app-events.json")
    let data = try! Data(contentsOf: url)
    return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
}()

private func rules(_ name: String) -> (required: [String], allowed: [String]) {
    let rule = contract[name] as! [String: Any]
    let required = rule["required"] as! [String]
    return (required, required + (rule["optional"] as? [String] ?? []))
}

private func matchesPattern(_ pattern: String, _ text: String) -> Bool {
    text.range(of: pattern, options: .regularExpression) != nil
}

/// The rules every app SDK is held to, from integrations/analytics-mobile/contract.
func expectContract(_ body: [String: Any], file: StaticString = #filePath, line: UInt = #line) {
    let time = contract["time"] as! String
    let bodyRules = rules("body")
    for field in bodyRules.required { XCTAssertNotNil(body[field], field, file: file, line: line) }
    for field in body.keys { XCTAssertTrue(bodyRules.allowed.contains(field), field, file: file, line: line) }
    let session = body["session"] as! [String: Any]
    for field in rules("session").required { XCTAssertNotNil(session[field], field, file: file, line: line) }
    let context = body["context"] as! [String: Any]
    let contextRules = rules("context")
    for field in contextRules.required { XCTAssertNotNil(context[field], field, file: file, line: line) }
    for field in context.keys { XCTAssertTrue(contextRules.allowed.contains(field), field, file: file, line: line) }
    XCTAssertTrue((contract["platforms"] as! [String]).contains(context["platform"] as! String), file: file, line: line)
    XCTAssertTrue((contract["device_types"] as! [String]).contains(context["device_type"] as! String), file: file, line: line)
    XCTAssertTrue(matchesPattern(time, body["sent_at"] as! String), file: file, line: line)
    let eventRules = rules("event")
    for event in body["events"] as! [[String: Any]] {
        for field in eventRules.required { XCTAssertNotNil(event[field], field, file: file, line: line) }
        for field in event.keys { XCTAssertTrue(eventRules.allowed.contains(field), field, file: file, line: line) }
        XCTAssertTrue(matchesPattern(contract["event_name"] as! String, event["name"] as! String), file: file, line: line)
        XCTAssertTrue(matchesPattern(time, event["time"] as! String), file: file, line: line)
    }
}

struct Offline: Error {}

final class FakeTransport: Transport {
    var sent: [[String: Any]] = []
    var answer: () throws -> Response = { Response(status: 200, text: "{}") }

    func post(url: URL, key postedKey: String, body: Data) throws -> Response {
        XCTAssertEqual(url.absoluteString, "https://events.kissmyapps.dev/v1/events")
        XCTAssertEqual(postedKey, key)
        sent.append(try JSONSerialization.jsonObject(with: body) as! [String: Any])
        return try answer()
    }
}

final class ClientTests: XCTestCase {
    private var scheduler = ManualScheduler()
    private var transport = FakeTransport()
    private var clients: [Client] = []
    private var logs: [String] = []

    override func setUp() {
        scheduler = ManualScheduler()
        transport = FakeTransport()
        clients = []
        logs = []
    }

    override func tearDown() {
        clients.forEach { $0.shutdown() }
    }

    private func start(
        _ store: Store?,
        options: KissMyAppsOptions = KissMyAppsOptions(appVersion: "2.4.0", build: "120"),
        key clientKey: String = key
    ) throws -> Client {
        let scheduler = self.scheduler
        let platform = Platform(
            store: store,
            transport: transport,
            scheduler: scheduler,
            device: { iphone },
            sdk: "kma-ios/1.0.0",
            now: { scheduler.now },
            log: { [weak self] in self?.logs.append($0) }
        )
        let client = try Client(key: clientKey, options: options, platform: platform)
        clients.append(client)
        return client
    }

    private func settle(_ milliseconds: Int64 = 0) {
        scheduler.advance(milliseconds)
        scheduler.advance(300)
    }

    private var sent: [[String: Any]] { transport.sent }

    private func events(_ bodies: [[String: Any]]? = nil) -> [[String: Any]] {
        (bodies ?? sent).flatMap { $0["events"] as! [[String: Any]] }
    }

    private func names(_ bodies: [[String: Any]]? = nil) -> [String] {
        events(bodies).map { $0["name"] as! String }
    }

    private func properties(_ event: [String: Any]) -> [String: Any] {
        event["properties"] as! [String: Any]
    }

    func testRecordsTheInstallOpenScreensAndEventsAndSendsThemOnBackgrounding() throws {
        let client = try start(MemoryStore())
        client.foreground()
        client.screen("Home", properties: [:])
        settle(1000)
        client.screen("Lesson", properties: [:])
        client.track("lesson_completed", properties: ["lesson": 3])
        scheduler.advance(62_700)
        client.background()
        settle()

        XCTAssertEqual(names(), [
            "session_started", "app_installed", "app_opened", "screen_viewed", "screen_viewed", "lesson_completed",
            "app_backgrounded",
        ])
        let all = events()
        XCTAssertEqual(properties(all[1])["version"] as? String, "2.4.0")
        XCTAssertEqual(properties(all[1])["build"] as? String, "120")
        XCTAssertEqual(properties(all[2])["from_background"] as? Bool, false)
        XCTAssertEqual(all[4]["screen"] as? String, "Lesson")
        XCTAssertEqual(properties(all[4])["previous"] as? String, "Home")
        XCTAssertEqual(properties(all[5])["lesson"] as? Int, 3)
        XCTAssertEqual(all[5]["screen"] as? String, "Lesson")
        XCTAssertEqual(properties(all[6])["seconds_in_foreground"] as? Int, 64)
        for body in sent {
            expectContract(body)
            XCTAssertEqual((body["session"] as? [String: Any])?["id"] as? String, client.getSessionId())
            let context = body["context"] as! [String: Any]
            XCTAssertEqual(context["platform"] as? String, "ios")
            XCTAssertEqual(context["sdk"] as? String, "kma-ios/1.0.0")
            XCTAssertEqual(context["app_version"] as? String, "2.4.0")
            XCTAssertEqual(context["page_path"] as? String, "Home")
            XCTAssertEqual(context["device_model"] as? String, "iPhone15,4")
        }
    }

    func testTellsAnUpdateFromAnInstallAndKeepsThePersonAndARecentSession() throws {
        let store = MemoryStore()
        let first = try start(store)
        first.foreground()
        settle()
        first.background()
        settle()
        let person = first.getAnonymousId()
        let session = first.getSessionId()
        first.shutdown()
        transport.sent = []

        scheduler.advance(minutes(5))
        let second = try start(store, options: KissMyAppsOptions(appVersion: "2.5.0", build: "130"))
        second.foreground()
        settle(10_000)
        XCTAssertEqual(names(), ["app_updated", "app_opened"])
        let updated = properties(events()[0])
        XCTAssertEqual(updated["version"] as? String, "2.5.0")
        XCTAssertEqual(updated["build"] as? String, "130")
        XCTAssertEqual(updated["previous_version"] as? String, "2.4.0")
        XCTAssertEqual(updated["previous_build"] as? String, "120")
        XCTAssertEqual(second.getAnonymousId(), person)
        XCTAssertEqual(second.getSessionId(), session)
    }

    func testStartsANewSessionAfter30MinutesAway() throws {
        let client = try start(MemoryStore())
        client.foreground()
        settle()
        let first = client.getSessionId()
        client.background()
        settle()
        transport.sent = []

        scheduler.advance(minutes(10))
        client.foreground()
        settle(10_000)
        XCTAssertEqual(names(), ["app_opened"])
        XCTAssertEqual(properties(events()[0])["from_background"] as? Bool, true)
        XCTAssertEqual(client.getSessionId(), first)
        client.background()
        settle()
        transport.sent = []

        scheduler.advance(minutes(31))
        client.foreground()
        settle(10_000)
        XCTAssertEqual(names(), ["session_started", "app_opened"])
        XCTAssertNotEqual(client.getSessionId(), first)
    }

    func testKeepsEventsOfflineRetriesAndSendsThemOnALaterLaunch() throws {
        let store = MemoryStore()
        transport.answer = { throw Offline() }
        let client = try start(store, options: KissMyAppsOptions(appVersion: "2.4.0", maxQueue: 4))
        client.foreground()
        for lesson in 1 ... 3 { client.track("lesson_completed", properties: ["lesson": lesson]) }
        client.background()
        settle(2000)
        XCTAssertFalse(sent.isEmpty)
        client.shutdown()

        // Only the newest four were kept.
        transport.sent = []
        transport.answer = { Response(status: 200, text: "{}") }
        let later = try start(store)
        settle(100)
        let delivered = events()
        XCTAssertEqual(delivered.map { $0["name"] as! String }, [
            "lesson_completed", "lesson_completed", "lesson_completed", "app_backgrounded",
        ])
        XCTAssertEqual(delivered.map { properties($0)["lesson"] as? Int }, [1, 2, 3, nil])
        XCTAssertEqual(later.getAnonymousId(), client.getAnonymousId())
    }

    func testDropsABatchTheServerRefusesButRetriesWhenItIsBusy() throws {
        let client = try start(MemoryStore())
        transport.answer = { Response(status: 503, text: "busy") }
        client.foreground()
        settle(10_000)
        XCTAssertEqual(sent.count, 1)
        transport.answer = { Response(status: 200, text: "{}") }
        settle(2000)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(
            events([sent[0]]).map { $0["insert_id"] as! String },
            events([sent[1]]).map { $0["insert_id"] as! String }
        )

        transport.answer = { Response(status: 400, text: "bad") }
        client.track("broken_event", properties: [:])
        settle(10_000)
        transport.answer = { Response(status: 200, text: "{}") }
        settle(60_000)
        XCTAssertEqual(names(Array(sent[2...])), ["broken_event"])
    }

    func testNamesThePersonOnceIdentifiedAndStartsSomeoneNewOnReset() throws {
        let client = try start(MemoryStore())
        client.foreground()
        client.identify("user-42", traits: ["email": "amaka@example.com", "plan": "annual"])
        settle()
        XCTAssertEqual(sent[0]["user_id"] as? String, "user-42")
        XCTAssertEqual((sent[0]["traits"] as? [String: Any])?["email"] as? String, "amaka@example.com")
        XCTAssertEqual((sent[0]["traits"] as? [String: Any])?["plan"] as? String, "annual")
        client.track("plan_selected", properties: [:])
        settle(10_000)
        XCTAssertEqual(sent[1]["user_id"] as? String, "user-42")
        XCTAssertNil(sent[1]["traits"])

        let before = client.getAnonymousId()
        client.track("signed_out", properties: [:])
        client.reset()
        client.track("browsed", properties: [:])
        settle(10_000)
        let after = Array(sent[2...])
        XCTAssertEqual(after[0]["anonymous_id"] as? String, before)
        XCTAssertEqual(after[0]["user_id"] as? String, "user-42")
        XCTAssertEqual(names([after[0]]), ["signed_out"])
        XCTAssertNotEqual(after[1]["anonymous_id"] as? String, before)
        XCTAssertNil(after[1]["user_id"])
        XCTAssertEqual(names([after[1]]), ["session_started", "browsed"])
    }

    func testStaysQuietAfterOptingOutAcrossLaunchesUntilOptingIn() throws {
        let store = MemoryStore()
        let client = try start(store)
        client.optOut()
        client.foreground()
        client.track("hidden", properties: [:])
        settle(10_000)
        XCTAssertEqual(sent.count, 0)
        client.shutdown()

        let next = try start(store)
        next.foreground()
        next.track("still_hidden", properties: [:])
        settle(10_000)
        XCTAssertEqual(sent.count, 0)
        next.optIn()
        next.track("visible", properties: [:])
        settle(10_000)
        XCTAssertEqual(names(), ["session_started", "visible"])
    }

    func testKeepsAnOpenAppOnlineWithAHeartbeat() throws {
        let client = try start(MemoryStore())
        client.foreground()
        settle(10_000)
        transport.sent = []
        // The minute after the last send passes with no request; the next one is a heartbeat.
        settle(50_000)
        XCTAssertEqual(sent.count, 0)
        settle(60_000)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual((sent[0]["events"] as? [Any])?.count, 0)
        XCTAssertEqual((sent[0]["session"] as? [String: Any])?["id"] as? String, client.getSessionId())
        client.background()
        settle()
        transport.sent = []
        settle(120_000)
        XCTAssertEqual(sent.count, 0)
    }

    func testRefusesAServerKeyAndIgnoresBadEventNames() throws {
        XCTAssertThrowsError(try start(nil, key: "kma_sk_live_ABCDEFGHJKLMNPQRSTUVWXYZ"))
        let client = try start(nil, options: KissMyAppsOptions(trackLifecycle: false, debug: true))
        client.foreground()
        client.track("not valid!", properties: [:])
        client.track("trailing_newline\n", properties: [:])
        client.track("valid_name", properties: [:])
        settle(10_000)
        XCTAssertEqual(names(), ["session_started", "valid_name"])
        XCTAssertTrue(logs.contains { $0.contains("not a valid event name") })
    }

    func testTurnsAppValuesIntoJSONAndDropsOversizedProperties() throws {
        let client = try start(MemoryStore(), options: KissMyAppsOptions(trackLifecycle: false, debug: true))
        client.foreground()
        let coupon: String? = nil
        client.track("checkout", properties: [
            "items": [["sku": "A1", "price": 9.99], ["sku": "B2", "price": 5]],
            "at": Date(timeIntervalSince1970: 0),
            "ratio": Double.nan,
            "coupon": coupon as Any,
            "big": Int64(12_000_000_000),
            "link": URL(string: "https://example.com/a")!,
        ])
        client.track("too_big", properties: ["text": String(repeating: "x", count: 40_000)])
        settle(10_000)
        let checkout = properties(events()[1])
        let items = checkout["items"] as! [[String: Any]]
        XCTAssertEqual(items[1]["sku"] as? String, "B2")
        XCTAssertEqual(items[0]["price"] as? Double, 9.99)
        XCTAssertEqual(checkout["at"] as? String, "1970-01-01T00:00:00.000Z")
        XCTAssertTrue(checkout["ratio"] is NSNull)
        XCTAssertTrue(checkout["coupon"] is NSNull)
        XCTAssertEqual((checkout["big"] as? NSNumber)?.int64Value, 12_000_000_000)
        XCTAssertEqual(checkout["link"] as? String, "https://example.com/a")
        XCTAssertEqual(properties(events()[2]).count, 0)
        XCTAssertTrue(logs.contains { $0.contains("over 32 KB") })
    }

    func testAFileStoreKeepsStateAcrossLaunches() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("kma-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = try start(FileStore(directory: directory))
        first.foreground()
        first.identify("user-7", traits: nil)
        first.background()
        settle()
        first.shutdown()

        let second = try start(FileStore(directory: directory))
        XCTAssertEqual(second.getAnonymousId(), first.getAnonymousId())
        XCTAssertEqual(second.getUserId(), "user-7")
    }

    func testFormatsTimesWithMilliseconds() {
        XCTAssertEqual(isoTime(1_793_354_340_123), "2026-10-30T09:59:00.123Z")
        XCTAssertEqual(isoTime(0), "1970-01-01T00:00:00.000Z")
    }
}
