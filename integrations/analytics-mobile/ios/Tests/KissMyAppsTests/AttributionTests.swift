import Foundation
import XCTest
@testable import KissMyApps

private let key = "kma_pk_live_ABCDEFGHJKLMNPQRSTUVWXYZ"
private let vendorId = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F"
private let appleAdsSample = "apple-ads-sample-1"
private let clickId = "Q2xpY2tJZDAwMDAwMDAwMQ"
private let lessonLink = URL(string: "https://fluent.go.kissmyapps.dev/lesson-4?dl=lesson&id=4")!
private let summerLink = URL(string: "https://fluent.go.kissmyapps.dev/summer?src=mail")!

private var attribution: [String: Any] { contract["attribution"] as! [String: Any] }

/// The contract's own example answer: matched through the install referrer, deep link `lesson`.
private var exampleAnswer: String {
    let examples = attribution["examples"] as! [String: Any]
    return JSONValue.string(examples["response"]!)!
}

private func answer(_ method: String, value: String?, params: [String: String] = [:], deferred: Bool) -> String {
    JSONValue.string([
        "matched": true, "method": method, "source": "tiktok", "campaign": "launch",
        "deep_link": ["value": value.map { $0 as Any } ?? NSNull(), "params": params, "deferred": deferred],
    ] as [String: Any])!
}

/// The rules of `attribution.install` or `attribution.open` in the contract, for an iOS body.
func expectAttributionContract(
    _ kind: String, _ body: [String: Any], file: StaticString = #filePath, line: UInt = #line
) {
    let rule = attribution[kind] as! [String: Any]
    let required = rule["required"] as! [String]
    let allowed = required + (rule["optional"] as! [String])
    for field in required { XCTAssertNotNil(body[field], field, file: file, line: line) }
    for field in body.keys { XCTAssertTrue(allowed.contains(field), field, file: file, line: line) }
    let fields = attribution["fields"] as! [String: Any]
    XCTAssertTrue((fields["platform"] as! [String]).contains(body["platform"] as? String ?? ""), file: file, line: line)
    XCTAssertEqual(body["platform"] as? String, "ios", file: file, line: line)
    for name in ["anonymous_id", "session_id", "sdk", "user_id", "app_version", appleAdsField] where body[name] != nil {
        XCTAssertTrue(body[name] is String, name, file: file, line: line)
    }
    for name in ["installed_at", "opened_at", "device_key", "clipboard_click"] where body[name] != nil {
        XCTAssertTrue(matchesPattern(fields[name] as! String, body[name] as? String ?? ""), name, file: file, line: line)
    }
    for name in ["link_url", "url"] where body[name] != nil {
        let link = body[name] as? String ?? ""
        XCTAssertTrue(link.hasPrefix("https://"), name, file: file, line: line)
        XCTAssertLessThanOrEqual(link.count, 2048, name, file: file, line: line)
    }
    XCTAssertLessThanOrEqual((body[appleAdsField] as? String)?.count ?? 0, 4096, file: file, line: line)
    // The Install Referrer is Android's.
    for name in ["referrer", "referrer_click_ts", "install_begin_ts"] {
        XCTAssertNil(body[name], name, file: file, line: line)
    }
    XCTAssertTrue(matchesPattern("^kma-ios/\\d+\\.\\d+\\.\\d+$", body["sdk"] as? String ?? ""), file: file, line: line)
}

final class AttributionTests: XCTestCase {
    private var scheduler = ManualScheduler()
    private var transport = FakeTransport()
    private var clients: [Client] = []
    private var device = iphone
    private var clipboard: String?
    private var clipboardReads = 0
    private var appleAds: String? = appleAdsSample
    private var mainCalls = 0
    private var delivered: [DeepLink] = []

    override func setUp() {
        scheduler = ManualScheduler()
        transport = FakeTransport()
        clients = []
        device = iphone
        device.vendorId = vendorId
        clipboard = "kma:\(clickId)"
        clipboardReads = 0
        appleAds = appleAdsSample
        mainCalls = 0
        delivered = []
    }

    override func tearDown() {
        clients.forEach { $0.shutdown() }
    }

    private func start(
        _ store: Store?, options: KissMyAppsOptions = KissMyAppsOptions(appVersion: "2.4.0", build: "120")
    ) throws -> Client {
        let scheduler = self.scheduler
        let platform = Platform(
            store: store,
            transport: transport,
            scheduler: scheduler,
            device: { [unowned self] in device },
            sdk: "kma-ios/\(sdkVersion)",
            now: { scheduler.now },
            log: { _ in },
            appleAdsAttribution: { [unowned self] in appleAds },
            readClipboard: { [unowned self] in
                clipboardReads += 1
                return clipboard
            },
            main: { [unowned self] run in
                mainCalls += 1
                run()
            }
        )
        let client = try Client(key: key, options: options, platform: platform)
        clients.append(client)
        return client
    }

    /// One launch of the app: open, a few seconds in the front, then away.
    private func launch(_ store: Store, options: KissMyAppsOptions = KissMyAppsOptions(appVersion: "2.4.0")) throws {
        let client = try start(store, options: options)
        client.foreground()
        settle(5000)
        client.background()
        settle()
        client.shutdown()
    }

    private func settle(_ milliseconds: Int64 = 0) {
        scheduler.advance(milliseconds)
        scheduler.advance(300)
    }

    private func bodies(_ path: String) -> [[String: Any]] {
        transport.calls.filter { $0.path == path }.map { $0.body }
    }

    private var installs: [[String: Any]] { bodies("/v1/attribution/install") }
    private var opens: [[String: Any]] { bodies("/v1/attribution/open") }
    private var events: [[String: Any]] { transport.sent.flatMap { $0["events"] as! [[String: Any]] } }

    func testCallsInstallOnceOnTheFirstLaunchAfterItsEventsWithTheContractBody() throws {
        let store = MemoryStore()
        let client = try start(store)
        client.foreground()
        client.screen("Home", properties: [:])
        settle(1000)
        XCTAssertTrue(installs.isEmpty, "it waits a moment for the link that opened the app")
        settle(1000)

        XCTAssertEqual(installs.count, 1)
        let body = installs[0]
        expectAttributionContract("install", body)
        // The events went first, so the server knows the session when it matches the install.
        XCTAssertEqual(transport.calls.map { $0.path }, ["/v1/events", "/v1/attribution/install"])
        let installed = events.first { $0["name"] as? String == "app_installed" }!
        XCTAssertEqual(body["installed_at"] as? String, installed["time"] as? String)
        XCTAssertEqual(body["session_id"] as? String, client.getSessionId())
        XCTAssertEqual(body["session_id"] as? String, (transport.sent[0]["session"] as? [String: Any])?["id"] as? String)
        XCTAssertEqual(body["anonymous_id"] as? String, client.getAnonymousId())
        XCTAssertEqual(body["sdk"] as? String, "kma-ios/1.1.0")
        XCTAssertEqual(body["app_version"] as? String, "2.4.0")
        XCTAssertEqual(body[appleAdsField] as? String, appleAdsSample)
        XCTAssertEqual(body["device_key"] as? String, sha256Hex(vendorId))
        XCTAssertEqual(body["device_key"] as? String, "949960179bb0c122dce42afa24e79611f32cbea403a75ffe8b4d5c07e73ed951")
        XCTAssertNil(body["link_url"])
        XCTAssertNil(body["user_id"])
        XCTAssertNil(body["clipboard_click"])
        XCTAssertEqual(clipboardReads, 0, "the clipboard is never read unless the app turned handoff on")
        let text = String(decoding: JSONValue.data(body)!, as: UTF8.self)
        XCTAssertFalse(text.contains(vendorId), "identifierForVendor itself never leaves the phone")

        // Answered: never again, on this launch or the next ones.
        client.background()
        settle()
        client.shutdown()
        try launch(store)
        try launch(store)
        XCTAssertEqual(installs.count, 1)
        XCTAssertTrue(opens.isEmpty)
    }

    func testRetriesOnUpToThreeMoreLaunchesWithTheFirstBody() throws {
        let store = MemoryStore()
        transport.attributionAnswer = { _ in throw Offline() }
        let first = try start(store)
        first.foreground()
        XCTAssertTrue(first.handleDeepLink(lessonLink))
        settle(5000)
        first.background()
        settle()
        first.shutdown()
        transport.attributionAnswer = { _ in Response(status: 503, text: "busy") }
        appleAds = "apple-ads-sample-2"
        try launch(store)
        for status in [408, 429] {
            transport.attributionAnswer = { _ in Response(status: status, text: "later") }
            try launch(store)
        }
        transport.attributionAnswer = { _ in throw Offline() }
        try launch(store)

        XCTAssertEqual(installs.count, 4, "the first launch, then one try on each of three more, then it gives up")
        let firstBody = installs[0]
        XCTAssertEqual(firstBody["link_url"] as? String, lessonLink.absoluteString)
        XCTAssertEqual(firstBody[appleAdsField] as? String, appleAdsSample)
        for body in installs {
            expectAttributionContract("install", body)
            for field in ["anonymous_id", "session_id", "installed_at", "link_url", "device_key", "app_version"] {
                XCTAssertEqual(body[field] as? String, firstBody[field] as? String, field)
            }
        }
        XCTAssertEqual(installs[1][appleAdsField] as? String, "apple-ads-sample-2", "fresh from Apple on each try")
        XCTAssertNotEqual(installs[1]["session_id"] as? String, nil)

        // A link once the install call is over has a call of its own.
        let later = try start(store)
        later.foreground()
        XCTAssertTrue(later.handleDeepLink(summerLink))
        XCTAssertEqual(opens.count, 1)
        XCTAssertEqual(installs.count, 4)
    }

    func testARetryNamesTheUserOnlyWhenThePersonIsTheSame() throws {
        let store = MemoryStore()
        transport.attributionAnswer = { _ in throw Offline() }
        try launch(store)
        let second = try start(store)
        second.identify("user-42", traits: nil)
        second.foreground()
        settle(5000)
        second.reset()
        second.identify("user-7", traits: nil)
        second.background()
        settle()
        second.shutdown()
        try launch(store)

        XCTAssertEqual(installs.count, 3)
        XCTAssertNil(installs[0]["user_id"])
        XCTAssertEqual(installs[1]["user_id"] as? String, "user-42")
        XCTAssertNil(installs[2]["user_id"], "after reset the user is someone else, not the installer")
        XCTAssertEqual(installs[2]["anonymous_id"] as? String, installs[0]["anonymous_id"] as? String)
    }

    func testStopsRetryingOnceAnsweredRefusedOrUnreadable() throws {
        let answered = MemoryStore()
        transport.attributionAnswer = { _ in Response(status: 500, text: "oops") }
        try launch(answered)
        transport.attributionAnswer = { _ in Response(status: 200, text: attributionOff) }
        try launch(answered)
        try launch(answered)
        XCTAssertEqual(installs.count, 2)

        for (status, text) in [(400, "bad body"), (401, "revoked"), (200, "<html>")] {
            transport.calls = []
            let store = MemoryStore()
            transport.attributionAnswer = { _ in Response(status: status, text: text) }
            try launch(store)
            try launch(store)
            XCTAssertEqual(installs.count, 1, "\(status) \(text) is not sent again")
        }
    }

    func testLinksOnARetryLaunchWaitForItsInstallCall() throws {
        let store = MemoryStore()
        transport.attributionAnswer = { _ in throw Offline() }
        try launch(store)

        // The next launch's install call fails too: a link that came first is dropped.
        let second = try start(store)
        second.foreground()
        XCTAssertTrue(second.handleDeepLink(summerLink))
        settle(5000)
        XCTAssertEqual(installs.count, 2)
        XCTAssertNil(installs[1]["link_url"], "only the first launch's first link goes with the install call")
        XCTAssertTrue(opens.isEmpty)
        second.shutdown()

        // Answered: the link that waited gets its own call after it.
        transport.attributionAnswer = { path in
            path.hasSuffix("/install")
                ? Response(status: 200, text: attributionOff)
                : Response(status: 200, text: answer("link_open", value: "summer", deferred: false))
        }
        let third = try start(store)
        third.onDeepLink { [unowned self] in delivered.append($0) }
        third.foreground()
        XCTAssertTrue(third.handleDeepLink(summerLink))
        XCTAssertTrue(opens.isEmpty, "an open before the install is answered would be taken for the install")
        settle(5000)
        XCTAssertEqual(transport.calls.suffix(2).map { $0.path }, ["/v1/attribution/install", "/v1/attribution/open"])
        expectAttributionContract("open", opens[0])
        XCTAssertEqual(delivered, [DeepLink(value: "summer", params: [:], deferred: false, url: summerLink)])
    }

    func testSendsTheOpeningLinkWithTheInstallCallAndLaterLinksToOpen() throws {
        transport.attributionAnswer = { path in
            path.hasSuffix("/install")
                ? Response(status: 200, text: answer("link_open", value: "lesson", params: ["id": "4"], deferred: true))
                : Response(status: 200, text: answer("link_open", value: "summer", deferred: false))
        }
        let store = MemoryStore()
        let early = try start(store)
        // A link before the launch was seen still goes with the install call.
        XCTAssertTrue(early.handleDeepLink(lessonLink))
        XCTAssertTrue(early.handleDeepLink(summerLink))
        early.onDeepLink { [unowned self] in delivered.append($0) }
        XCTAssertTrue(transport.calls.isEmpty)
        early.foreground()
        settle()

        // The first link went with the install call, at once; the second waited for its answer.
        XCTAssertEqual(installs.count, 1)
        XCTAssertEqual(transport.calls.map { $0.path }, ["/v1/events", "/v1/attribution/install", "/v1/attribution/open"])
        expectAttributionContract("install", installs[0])
        XCTAssertEqual(installs[0]["link_url"] as? String, lessonLink.absoluteString)
        XCTAssertEqual(opens[0]["url"] as? String, summerLink.absoluteString)
        XCTAssertEqual(delivered.first, DeepLink(value: "lesson", params: ["id": "4"], deferred: true, url: lessonLink))
        early.shutdown()
        transport.calls = []
        delivered = []
        mainCalls = 0

        let client = try start(MemoryStore())
        client.onDeepLink { [unowned self] in delivered.append($0) }
        client.foreground()
        settle(200)
        XCTAssertTrue(installs.isEmpty)
        XCTAssertTrue(client.handleDeepLink(lessonLink))

        // The link arrived before the install call, so the call goes at once and carries it.
        XCTAssertEqual(installs.count, 1)
        XCTAssertTrue(opens.isEmpty)
        expectAttributionContract("install", installs[0])
        XCTAssertEqual(installs[0]["link_url"] as? String, lessonLink.absoluteString)
        XCTAssertEqual(delivered, [DeepLink(value: "lesson", params: ["id": "4"], deferred: true, url: lessonLink)])
        settle(5000)
        XCTAssertEqual(installs.count, 1, "the waiting call was dropped")

        client.identify("user-42", traits: nil)
        settle(10_000)
        XCTAssertTrue(client.handleDeepLink(summerLink))
        XCTAssertEqual(opens.count, 1)
        let open = opens[0]
        expectAttributionContract("open", open)
        XCTAssertEqual(open["url"] as? String, summerLink.absoluteString)
        XCTAssertEqual(open["user_id"] as? String, "user-42")
        XCTAssertEqual(open["session_id"] as? String, client.getSessionId())
        XCTAssertEqual(open["opened_at"] as? String, isoTime(scheduler.now))
        XCTAssertEqual(open["device_key"] as? String, sha256Hex(vendorId))
        XCTAssertEqual(open["app_version"] as? String, "2.4.0")
        XCTAssertEqual(delivered.count, 2)
        XCTAssertEqual(delivered[1], DeepLink(value: "summer", params: [:], deferred: false, url: summerLink))
        XCTAssertEqual(mainCalls, 2, "deep links are handed over on the main thread")

        // Only https links are sent.
        let before = transport.calls.count
        XCTAssertFalse(client.handleDeepLink(URL(string: "fluent://lesson/4")!))
        XCTAssertFalse(client.handleDeepLink(URL(string: "http://fluent.go.kissmyapps.dev/lesson-4")!))
        let long = "https://fluent.go.kissmyapps.dev/" + String(repeating: "a", count: 2048)
        XCTAssertFalse(client.handleDeepLink(URL(string: long)!))
        XCTAssertEqual(transport.calls.count, before)
    }

    func testHoldsADeepLinkUntilACallbackIsSetAndGivesItOnce() throws {
        transport.attributionAnswer = { _ in Response(status: 200, text: exampleAnswer) }
        let client = try start(MemoryStore())
        client.foreground()
        settle(2000)
        XCTAssertEqual(installs.count, 1)
        XCTAssertEqual(mainCalls, 0)

        var first: [DeepLink] = []
        var second: [DeepLink] = []
        client.onDeepLink { first.append($0) }
        XCTAssertEqual(first, [DeepLink(value: "lesson", params: ["id": "4"], deferred: true, url: nil)])
        client.onDeepLink { second.append($0) }
        settle(10_000)
        XCTAssertEqual(first.count, 1)
        XCTAssertTrue(second.isEmpty, "a deep link is given once, not again to a new callback")

        // Later deep links go to the newest callback.
        transport.attributionAnswer = { _ in Response(status: 200, text: answer("link_open", value: "summer", deferred: false)) }
        XCTAssertTrue(client.handleDeepLink(summerLink))
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(second.map { $0.value }, ["summer"])
    }

    func testReadsTheClipboardOnlyWithHandoffOnAndOnlyOnce() throws {
        let handoff = KissMyAppsOptions(appVersion: "2.4.0", clipboardHandoff: true)
        try launch(MemoryStore())
        XCTAssertEqual(clipboardReads, 0)
        XCTAssertNil(installs[0]["clipboard_click"])

        transport.calls = []
        let store = MemoryStore()
        transport.attributionAnswer = { _ in throw Offline() }
        try launch(store, options: handoff)
        transport.attributionAnswer = { _ in Response(status: 200, text: attributionOff) }
        clipboard = "something else"
        try launch(store, options: handoff)
        XCTAssertEqual(installs.count, 2)
        for body in installs {
            expectAttributionContract("install", body)
            XCTAssertEqual(body["clipboard_click"] as? String, clickId)
        }
        XCTAssertEqual(clipboardReads, 1, "read on the first call only, so iOS asks the person at most once")

        transport.calls = []
        clipboard = "Dinner at 8?"
        try launch(MemoryStore(), options: handoff)
        XCTAssertEqual(clipboardReads, 2)
        XCTAssertNil(installs[0]["clipboard_click"])
    }

    func testTakesOnlyAKmaClickIdFromTheClipboard() {
        XCTAssertEqual(clipboardClick("kma:\(clickId)"), clickId)
        XCTAssertEqual(clipboardClick(" kma:\(clickId)\n"), clickId)
        XCTAssertEqual(clipboardClick("kma:abc-DEF_0123456789"), "abc-DEF_0123456789")
        XCTAssertNil(clipboardClick(nil))
        XCTAssertNil(clipboardClick(clickId))
        XCTAssertNil(clipboardClick("KMA:\(clickId)"))
        XCTAssertNil(clipboardClick("kma:short"))
        XCTAssertNil(clipboardClick("kma:\(String(repeating: "a", count: 41))"))
        XCTAssertNil(clipboardClick("kma:has spaces in the id!"))
        XCTAssertNil(clipboardClick("kma:\(clickId)\nkma:\(clickId)"))
    }

    func testSendsTheInstallCallAtOnceWhenTheAppLeavesBeforeIt() throws {
        let client = try start(MemoryStore())
        client.foreground()
        settle()
        client.background()
        XCTAssertEqual(installs.count, 1)
        XCTAssertEqual(transport.calls.map { $0.path }, ["/v1/events", "/v1/attribution/install"])
        XCTAssertEqual(
            events.map { $0["name"] as! String }, ["session_started", "app_installed", "app_opened", "app_backgrounded"]
        )
        settle(10_000)
        XCTAssertEqual(installs.count, 1)
    }

    func testAnAppUpdatedFromSdk10MakesNoInstallCallButSendsLinks() throws {
        let client = try start(MemoryStore.returning())
        client.foreground()
        settle(10_000)
        XCTAssertTrue(installs.isEmpty)
        XCTAssertTrue(client.handleDeepLink(lessonLink))
        XCTAssertEqual(opens.count, 1)
        expectAttributionContract("open", opens[0])
        XCTAssertEqual(opens[0]["anonymous_id"] as? String, "5f0c7a9e-3b1d-4c2a-9e8f-1a2b3c4d5e6f")
    }

    func testSendsNothingWhileOptedOutAndTheInstallCallAtOptIn() throws {
        let store = MemoryStore()
        let client = try start(store)
        client.optOut()
        client.foreground()
        XCTAssertTrue(client.handleDeepLink(lessonLink))
        settle(10_000)
        client.background()
        settle()
        client.shutdown()
        let next = try start(store)
        next.foreground()
        settle(10_000)
        XCTAssertTrue(transport.calls.isEmpty)

        scheduler.advance(60_000)
        next.optIn()
        XCTAssertEqual(installs.count, 1)
        expectAttributionContract("install", installs[0])
        XCTAssertEqual(installs[0]["installed_at"] as? String, isoTime(1_793_354_340_000), "the first launch")
        XCTAssertNil(installs[0]["link_url"], "links are not kept while opted out")
        XCTAssertEqual(installs[0]["session_id"] as? String, next.getSessionId())
        XCTAssertEqual(transport.calls.first?.path, "/v1/events", "with the new session's first events before it")
    }

    func testCallsInstallWithLifecycleTrackingOff() throws {
        let client = try start(MemoryStore(), options: KissMyAppsOptions(trackLifecycle: false))
        client.foreground()
        settle(2000)
        XCTAssertEqual(installs.count, 1)
        expectAttributionContract("install", installs[0])
        XCTAssertFalse(events.contains { $0["name"] as? String == "app_installed" })
    }

    func testLeavesOutWhatThePhoneDoesNotHave() throws {
        device.vendorId = nil
        appleAds = String(repeating: "t", count: 4097)
        try launch(MemoryStore())
        XCTAssertEqual(installs.count, 1)
        expectAttributionContract("install", installs[0])
        XCTAssertNil(installs[0]["device_key"])
        XCTAssertNil(installs[0][appleAdsField], "an Apple Ads value over 4,096 characters is left out")
    }

    func testReadsTheAnswersTheContractDescribes() {
        let example = AttributionAnswer.parse(exampleAnswer, url: nil)!
        XCTAssertTrue(example.matched)
        XCTAssertEqual(example.method, "install_referrer")
        XCTAssertEqual(example.deepLink, DeepLink(value: "lesson", params: ["id": "4"], deferred: true, url: nil))
        let methods = (attribution["response"] as! [String: Any])["methods"] as! [String]
        XCTAssertTrue(methods.contains(example.method))

        let off = AttributionAnswer.parse(attributionOff, url: lessonLink)!
        XCTAssertFalse(off.matched)
        XCTAssertEqual(off.method, "off")
        XCTAssertNil(off.deepLink)

        let typed = AttributionAnswer.parse(
            #"{"matched":true,"method":"link_open","deep_link":{"value":null,"params":{"id":"4","n":4,"one":1,"pi":3.5,"on":true,"off":false,"x":{},"l":[1]},"deferred":false}}"#,
            url: lessonLink
        )!
        XCTAssertEqual(typed.deepLink, DeepLink(
            value: nil,
            params: ["id": "4", "n": "4", "one": "1", "pi": "3.5", "on": "true", "off": "false"],
            deferred: false,
            url: lessonLink
        ))
        let many = (1 ... 12).map { "\"k\($0)\":\"v\"" }.joined(separator: ",")
        let crowded = AttributionAnswer.parse(
            #"{"matched":true,"method":"link_open","deep_link":{"value":"a","params":{"# + many + #"},"deferred":true}}"#,
            url: nil
        )!
        XCTAssertEqual(crowded.deepLink?.params.count, 10)
        let unknown = AttributionAnswer.parse(#"{"matched":true,"method":"something_new","deep_link":null}"#, url: nil)
        XCTAssertEqual(unknown?.method, "something_new", "a method this SDK does not know is still an answer")

        XCTAssertNil(AttributionAnswer.parse("busy", url: nil))
        XCTAssertNil(AttributionAnswer.parse(#"{"matched":true}"#, url: nil))
        XCTAssertNil(AttributionAnswer.parse(#"{"matched":true,"method":"clipboard","deep_link":{"value":"a"}}"#, url: nil))
    }

    func testTheContractsIosExampleMeetsTheRules() {
        let examples = attribution["examples"] as! [String: Any]
        expectAttributionContract("open", examples["open"] as! [String: Any])
    }

    func testHashesWithSha256() {
        let vectors = [
            "": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "abc": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "test": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq":
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            String(repeating: "a", count: 1000):
                "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
            "héllo wörld ✓": "c2a59c71097b678dc5af2eb1f98ddc575b63948b0fa6740071a945673aaada4d",
        ]
        for (text, hash) in vectors {
            XCTAssertEqual(portableSHA256Hex(text), hash, text)
            XCTAssertEqual(sha256Hex(text), hash, text)
        }
        XCTAssertEqual(deviceKey(vendorId), sha256Hex(vendorId))
        XCTAssertNil(deviceKey(nil))
        XCTAssertNil(deviceKey(""))
        // The contract's example device key is the SHA-256 of "test".
        let example = (attribution["examples"] as! [String: Any])["install"] as! [String: Any]
        XCTAssertEqual(example["device_key"] as? String, sha256Hex("test"))
    }
}
