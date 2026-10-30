import Foundation

/// KissMyApps analytics for iOS: sessions, installs, updates, opens, screens and your own
/// events, sent to your KissMyApps project.
///
/// Call `start(key:)` once at launch, then `track`, `screen` and `identify` from anywhere.
/// Every call returns at once; the work happens on the SDK's own queue.
public enum KissMyApps {
    private static let lock = NSLock()
    private static var client: Client?
    // Calls made before start run once it is called.
    private static var early: [(Client) -> Void] = []
    #if os(iOS)
    private static var lifecycle: AppLifecycle?
    #endif

    /// Starts the SDK with the project's client key, from Settings > API keys in the console.
    /// Call it on the main thread, in `application(_:didFinishLaunchingWithOptions:)` or your
    /// SwiftUI `App`'s `init`.
    public static func start(key: String, options: KissMyAppsOptions = KissMyAppsOptions()) {
        lock.lock()
        if client != nil {
            lock.unlock()
            return
        }
        var options = options
        let info = Bundle.main.infoDictionary ?? [:]
        if options.appVersion == nil { options.appVersion = info["CFBundleShortVersionString"] as? String }
        if options.build == nil { options.build = info["CFBundleVersion"] as? String }
        let device = DeviceBox(currentDevice())
        let platform = Platform(
            store: FileStore(directory: storageDirectory()),
            transport: URLSessionTransport(),
            scheduler: DispatchScheduler(),
            device: { device.value },
            sdk: "kma-ios/\(sdkVersion)"
        )
        let started: Client
        do {
            started = try Client(key: key, options: options, platform: platform)
        } catch {
            lock.unlock()
            print("KissMyApps: start needs a client key that starts with kma_pk_ and a valid endpoint.")
            assertionFailure("KissMyApps: start needs a client key that starts with kma_pk_")
            return
        }
        client = started
        let pending = early
        early.removeAll()
        lock.unlock()
        #if os(iOS)
        lifecycle = AppLifecycle(client: started, device: device)
        #else
        started.foreground()
        #endif
        pending.forEach { $0(started) }
    }

    /// Records something a person did, such as `lesson_completed`, with optional properties.
    public static func track(_ name: String, properties: [String: Any] = [:]) {
        call { $0.track(name, properties: properties) }
    }

    /// Records a screen view; later events carry the screen's name.
    public static func screen(_ name: String, properties: [String: Any] = [:]) {
        call { $0.screen(name, properties: properties) }
    }

    /// Ties this install to your own user ID, with optional traits such as email, name or plan.
    public static func identify(_ userId: String, traits: [String: Any]? = nil) {
        call { $0.identify(userId, traits: traits) }
    }

    /// Updates traits for the current person without changing who they are.
    public static func setTraits(_ traits: [String: Any]) {
        call { $0.setTraits(traits) }
    }

    /// Forgets the user, for example on sign out: what follows is a new person and session.
    public static func reset() {
        call { $0.reset() }
    }

    /// Stops recording and drops anything not sent yet, until `optIn()`. Remembered across launches.
    public static func optOut() {
        call { $0.optOut() }
    }

    public static func optIn() {
        call { $0.optIn() }
    }

    /// Sends everything queued now.
    public static func flush() {
        call { $0.flush() }
    }

    /// The ID of this install's person until `identify`, or nil before `start`.
    public static var anonymousId: String? {
        currentClient()?.getAnonymousId()
    }

    public static var sessionId: String? {
        currentClient()?.getSessionId()
    }

    private static func currentClient() -> Client? {
        lock.lock()
        defer { lock.unlock() }
        return client
    }

    private static func call(_ run: @escaping (Client) -> Void) {
        lock.lock()
        if let current = client {
            lock.unlock()
            run(current)
            return
        }
        if early.count < 100 { early.append(run) }
        lock.unlock()
    }
}

/// The device's details, refreshed on the main thread each time the app comes to the front.
final class DeviceBox {
    private let lock = NSLock()
    private var current: DeviceInfo

    init(_ value: DeviceInfo) {
        current = value
    }

    var value: DeviceInfo {
        get { lock.lock(); defer { lock.unlock() }; return current }
        set { lock.lock(); current = newValue; lock.unlock() }
    }
}
