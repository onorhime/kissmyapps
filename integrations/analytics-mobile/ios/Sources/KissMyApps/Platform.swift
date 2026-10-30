import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// What the client needs from the platform. The iOS layer passes real ones; tests pass fakes
// with a clock they control.

struct DeviceInfo {
    var platform: String
    var osName: String
    var osVersion: String
    var deviceType: String
    var deviceModel: String?
    var screenWidth: Int
    var screenHeight: Int
    var timezone: String
    var language: String
}

protocol Store: AnyObject {
    func read(_ name: String) -> String?
    func write(_ name: String, _ value: String)
}

struct Response {
    let status: Int
    let text: String
}

protocol Transport: AnyObject {
    /// Throws when the request could not be made, such as when the device is offline.
    func post(url: URL, key: String, body: Data) throws -> Response
}

protocol Cancellable {
    func cancel()
}

struct BlockCancellable: Cancellable {
    let block: () -> Void
    func cancel() { block() }
}

/// Runs tasks one at a time, in order, off the caller's thread.
protocol Scheduler: AnyObject {
    func execute(_ task: @escaping () -> Void)
    func schedule(after milliseconds: Int64, _ task: @escaping () -> Void) -> Cancellable
}

struct Platform {
    var store: Store?
    var transport: Transport
    var scheduler: Scheduler
    var device: () -> DeviceInfo
    var sdk: String
    var now: () -> Int64 = { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
    var log: (String) -> Void = { print($0) }
}

/// Keeps each value in its own file, replaced whole so a crash never leaves half a file.
final class FileStore: Store {
    let directory: URL

    init(directory: URL) {
        self.directory = directory
    }

    func read(_ name: String) -> String? {
        try? String(contentsOf: directory.appendingPathComponent("\(name).json"), encoding: .utf8)
    }

    func write(_ name: String, _ value: String) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? Data(value.utf8).write(to: directory.appendingPathComponent("\(name).json"), options: .atomic)
    }
}

final class URLSessionTransport: Transport {
    private final class Box {
        var result: Result<Response, Error> = .failure(URLError(.unknown))
    }

    private let session: URLSession

    init(timeout: TimeInterval = 15) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        session = URLSession(configuration: configuration)
    }

    func post(url: URL, key: String, body: Data) throws -> Response {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.httpBody = body
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: request) { data, response, error in
            if let error = error {
                box.result = .failure(error)
            } else if let http = response as? HTTPURLResponse {
                let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                box.result = .success(Response(status: http.statusCode, text: text))
            }
            done.signal()
        }
        task.resume()
        done.wait()
        return try box.result.get()
    }
}

/// One serial queue for the SDK.
final class DispatchScheduler: Scheduler {
    private let queue = DispatchQueue(label: "dev.kissmyapps.sdk")

    func execute(_ task: @escaping () -> Void) {
        queue.async(execute: task)
    }

    func schedule(after milliseconds: Int64, _ task: @escaping () -> Void) -> Cancellable {
        let item = DispatchWorkItem(block: task)
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(milliseconds)), execute: item)
        return BlockCancellable { item.cancel() }
    }
}
