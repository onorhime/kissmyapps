import Foundation
import XCTest
@testable import KissMyApps

/// The client on its real queue and URLSession, against a running ingest:
/// KMA_CONTRACT_ENDPOINT=http://127.0.0.1:8788 KMA_CONTRACT_KEY=kma_pk_test_… swift test
final class LiveDeliveryTests: XCTestCase {
    private final class Recording: Transport {
        let http = URLSessionTransport()
        let lock = NSLock()
        var replies: [[String: Any]] = []
        let done = XCTestExpectation(description: "the ingest answered the backgrounding batch")

        func post(url: URL, key: String, body: Data) throws -> Response {
            let response = try http.post(url: url, key: key, body: body)
            var reply = (try? JSONSerialization.jsonObject(with: Data(response.text.utf8))) as? [String: Any] ?? [:]
            reply["status"] = response.status
            lock.lock()
            replies.append(reply)
            lock.unlock()
            if String(decoding: body, as: UTF8.self).contains("app_backgrounded") { done.fulfill() }
            return response
        }
    }

    func testARunningIngestStoresEverythingTheSdkSends() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let endpoint = environment["KMA_CONTRACT_ENDPOINT"], !endpoint.isEmpty,
              let key = environment["KMA_CONTRACT_KEY"], !key.isEmpty
        else { throw XCTSkip("KMA_CONTRACT_ENDPOINT and KMA_CONTRACT_KEY are not set") }
        let recording = Recording()
        let platform = Platform(
            store: nil,
            transport: recording,
            scheduler: DispatchScheduler(),
            device: { iphone },
            sdk: "kma-ios/\(sdkVersion)"
        )
        let client = try Client(
            key: key,
            options: KissMyAppsOptions(appVersion: "1.0.0", build: "1", endpoint: endpoint, debug: true),
            platform: platform
        )
        client.foreground()
        client.identify("ios-contract-\(Int(Date().timeIntervalSince1970))", traits: ["plan": "annual"])
        client.screen("Home", properties: [:])
        client.track("lesson_completed", properties: ["lesson": 1, "sdk": "ios"])
        client.background()
        wait(for: [recording.done], timeout: 15)
        print("KMA contract: anonymous_id=\(client.getAnonymousId()) replies=\(recording.replies)")
        for reply in recording.replies {
            XCTAssertEqual(reply["status"] as? Int, 200, "\(reply)")
            XCTAssertEqual((reply["rejected"] as? [Any])?.count, 0, "\(reply)")
        }
        XCTAssertEqual(recording.replies.reduce(0) { $0 + ($1["stored"] as? Int ?? 0) }, 6)
        client.shutdown()
    }
}
