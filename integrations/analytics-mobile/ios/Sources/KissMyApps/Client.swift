import Foundation

let sdkVersion = "1.0.0"
let heartbeatMilliseconds: Int64 = 60_000

private let batchSize = 50
private let flushAt = 30
private let maxPropertiesBytes = 32_000
private let eventNamePattern = try! NSRegularExpression(pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,79}\\z")
private let keyPattern = try! NSRegularExpression(pattern: "^kma_pk_(live|test)_[A-Za-z0-9]{20,64}\\z")

func matches(_ pattern: NSRegularExpression, _ text: String) -> Bool {
    pattern.firstMatch(in: text, options: [], range: NSRange(text.startIndex..., in: text)) != nil
}

func isEventName(_ name: String) -> Bool {
    matches(eventNamePattern, name)
}

func uuid() -> String {
    UUID().uuidString.lowercased()
}

enum ClientError: Error {
    case invalidKey
    case invalidEndpoint
}

final class Session {
    let id: String
    let started: Int64
    var last: Int64
    var firstScreen: String?

    init(id: String, started: Int64, last: Int64, firstScreen: String?) {
        self.id = id
        self.started = started
        self.last = last
        self.firstScreen = firstScreen
    }

    var json: [String: Any] {
        var json: [String: Any] = ["id": id, "started": started, "last": last]
        if let firstScreen = firstScreen { json["firstScreen"] = firstScreen }
        return json
    }

    static func from(_ value: Any?) -> Session? {
        guard let json = value as? [String: Any],
              let id = json["id"] as? String,
              let started = JSONValue.int64(json["started"]),
              let last = JSONValue.int64(json["last"])
        else { return nil }
        return Session(id: id, started: started, last: last, firstScreen: json["firstScreen"] as? String)
    }
}

struct QueuedEvent {
    let name: String
    let insertId: String
    let time: String
    let screen: String?
    let properties: [String: Any]
    let userId: String?
    let anonymousId: String
    let sessionId: String
    let sessionStartedAt: String

    /// The event as the request carries it.
    var requestJSON: [String: Any] {
        var json: [String: Any] = [
            "name": name,
            "insert_id": insertId,
            "time": time,
            "properties": properties,
            "user_id": userId ?? NSNull(),
        ]
        if let screen = screen { json["screen"] = screen }
        return json
    }

    var json: [String: Any] {
        var json = requestJSON
        json["anonymous_id"] = anonymousId
        json["session_id"] = sessionId
        json["session_started_at"] = sessionStartedAt
        return json
    }

    init(
        name: String, insertId: String, time: String, screen: String?, properties: [String: Any],
        userId: String?, anonymousId: String, sessionId: String, sessionStartedAt: String
    ) {
        self.name = name
        self.insertId = insertId
        self.time = time
        self.screen = screen
        self.properties = properties
        self.userId = userId
        self.anonymousId = anonymousId
        self.sessionId = sessionId
        self.sessionStartedAt = sessionStartedAt
    }

    init?(json: [String: Any]) {
        guard let name = json["name"] as? String,
              let insertId = json["insert_id"] as? String,
              let time = json["time"] as? String,
              let anonymousId = json["anonymous_id"] as? String,
              let sessionId = json["session_id"] as? String,
              let sessionStartedAt = json["session_started_at"] as? String
        else { return nil }
        self.init(
            name: name, insertId: insertId, time: time, screen: json["screen"] as? String,
            properties: json["properties"] as? [String: Any] ?? [:], userId: json["user_id"] as? String,
            anonymousId: anonymousId, sessionId: sessionId, sessionStartedAt: sessionStartedAt
        )
    }
}

/// The SDK's state and rules. Everything that touches state runs on `Platform.scheduler`,
/// one task at a time; the getters can be read from any thread.
final class Client {
    let key: String
    let options: KissMyAppsOptions
    private let endpoint: URL
    private let platform: Platform
    private let storageName: String

    private let lock = NSLock()
    private let loaded = DispatchGroup()
    private var sharedAnonymousId = uuid()
    private var sharedUserId: String?
    private var sharedSession: Session?

    private var traits: [String: Any]?
    private var traitsVersion = 0
    private var optedOut = false
    private var version: String?
    private var build: String?

    private var queue: [QueuedEvent] = []
    private var screenName: String?
    private var foregroundAt: Int64 = 0
    private var flushTask: Cancellable?
    private var heartbeatTask: Cancellable?
    private var saveTask: Cancellable?
    private var failures = 0
    private var lastSent: Int64 = 0
    private var identityPending = false
    private var inForeground = false
    private var firstLaunch = false
    private var stopped = false

    init(key: String, options: KissMyAppsOptions, platform: Platform) throws {
        guard matches(keyPattern, key) else { throw ClientError.invalidKey }
        var base = options.endpoint
        while base.hasSuffix("/") { base.removeLast() }
        guard let endpoint = URL(string: "\(base)/v1/events") else { throw ClientError.invalidEndpoint }
        self.key = key
        self.options = options
        self.endpoint = endpoint
        self.platform = platform
        storageName = "kma-\(key.suffix(8))"
        loaded.enter()
        later { [self] in load() }
    }

    // State shared with other threads ----------------------------------------------------------

    private var anonymousId: String {
        get { lock.lock(); defer { lock.unlock() }; return sharedAnonymousId }
        set { lock.lock(); sharedAnonymousId = newValue; lock.unlock() }
    }

    private var userId: String? {
        get { lock.lock(); defer { lock.unlock() }; return sharedUserId }
        set { lock.lock(); sharedUserId = newValue; lock.unlock() }
    }

    private var session: Session? {
        get { lock.lock(); defer { lock.unlock() }; return sharedSession }
        set { lock.lock(); sharedSession = newValue; lock.unlock() }
    }

    // Public API -------------------------------------------------------------------------------

    func track(_ name: String, properties: [String: Any]) {
        later { [self] in
            guard !stopped, !optedOut else { return }
            guard isEventName(name) else {
                warn("\"\(name)\" is not a valid event name: use letters, numbers and _ . : - (up to 80).")
                return
            }
            enqueue(name, clean(properties), ensureSession())
        }
    }

    func screen(_ name: String, properties: [String: Any]) {
        let screen = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
        guard !screen.isEmpty else { return warn("screen needs a name.") }
        later { [self] in
            guard !stopped, !optedOut else { return }
            let previous = screenName
            screenName = screen
            let current = ensureSession()
            if current.firstScreen == nil {
                current.firstScreen = screen
                save()
            }
            var values: [String: Any] = ["name": screen]
            if let previous = previous { values["previous"] = previous }
            values.merge(clean(properties)) { _, new in new }
            enqueue("screen_viewed", values, current)
        }
    }

    func identify(_ id: String, traits newTraits: [String: Any]?) {
        let user = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty, user.count <= 200 else {
            return warn("identify needs a user ID of 1 to 200 characters.")
        }
        later { [self] in
            userId = user
            if let newTraits = newTraits { mergeTraits(newTraits) }
            identityPending = true
            save()
            scheduleFlush(0)
        }
    }

    func setTraits(_ newTraits: [String: Any]) {
        later { [self] in
            mergeTraits(newTraits)
            identityPending = true
            save()
            scheduleFlush(0)
        }
    }

    /// Forgets the user, for example on sign out: what follows is a new person and session.
    func reset() {
        later { [self] in
            sendQueued()
            userId = nil
            traits = nil
            traitsVersion += 1
            identityPending = false
            anonymousId = uuid()
            session = nil
            save()
            if inForeground { _ = ensureSession() }
        }
    }

    func optOut() {
        later { [self] in
            optedOut = true
            queue.removeAll()
            save()
        }
    }

    func optIn() {
        later { [self] in
            optedOut = false
            save()
        }
    }

    func flush() {
        later { [self] in sendQueued() }
    }

    func getAnonymousId() -> String {
        awaitLoad()
        return anonymousId
    }

    func getUserId() -> String? {
        awaitLoad()
        return userId
    }

    func getSessionId() -> String? {
        awaitLoad()
        return session?.id
    }

    /// Runs after everything already asked of the client.
    func afterPendingWork(_ task: @escaping () -> Void) {
        later(task)
    }

    func shutdown() {
        later { [self] in
            stopped = true
            inForeground = false
            flushTask?.cancel()
            heartbeatTask?.cancel()
            if saveTask != nil { writeNow() }
        }
    }

    // App lifecycle, called by the platform layer --------------------------------------------

    /// The app came to the front. The first call is the launch.
    func foreground() {
        later { [self] in
            guard !stopped, !inForeground else { return }
            let launch = foregroundAt == 0
            inForeground = true
            foregroundAt = platform.now()
            guard !optedOut else { return }
            let current = ensureSession()
            if options.trackLifecycle {
                if launch { recordInstallOrUpdate(current) }
                enqueue("app_opened", ["from_background": !launch], current)
            }
            if heartbeatTask == nil { scheduleHeartbeat() }
        }
    }

    /// The app went to the background: record it and send what is queued while it can.
    func background() {
        later { [self] in
            guard !stopped, inForeground else { return }
            inForeground = false
            heartbeatTask?.cancel()
            heartbeatTask = nil
            guard !optedOut else { return }
            let current = session
            if let current = current, options.trackLifecycle {
                let seconds = Int64((Double(platform.now() - foregroundAt) / 1000).rounded())
                enqueue("app_backgrounded", ["seconds_in_foreground": max(0, seconds)], current)
            }
            current?.last = platform.now()
            writeNow()
            sendQueued()
        }
    }

    // State ----------------------------------------------------------------------------------

    private func later(_ task: @escaping () -> Void) {
        platform.scheduler.execute(task)
    }

    private func awaitLoad() {
        _ = loaded.wait(timeout: .now() + 1)
    }

    private func load() {
        let store = platform.store
        if store == nil { warn("No storage was given, so each launch counts as a new install.") }
        let saved = JSONValue.parse(store?.read(storageName)) as? [String: Any]
        let savedQueue = JSONValue.parse(store?.read("\(storageName)-queue")) as? [[String: Any]] ?? []
        queue = savedQueue.compactMap { QueuedEvent(json: $0) }
        let savedId = saved?["anonymousId"] as? String
        if let saved = saved, let savedId = savedId {
            anonymousId = savedId
            userId = saved["userId"] as? String
            traits = saved["traits"] as? [String: Any]
            session = Session.from(saved["session"])
            optedOut = saved["optedOut"] as? Bool ?? false
            version = saved["version"] as? String
            build = saved["build"] as? String
        }
        // Nothing saved means a first launch, or the app's data was cleared.
        firstLaunch = savedId == nil
        identityPending = traits != nil
        loaded.leave()
        // What an earlier launch could not send goes now.
        if !queue.isEmpty { scheduleFlush(0) }
    }

    private func recordInstallOrUpdate(_ current: Session) {
        let appVersion = options.appVersion
        let appBuild = options.build
        if firstLaunch {
            var properties: [String: Any] = [:]
            properties["version"] = appVersion
            properties["build"] = appBuild
            enqueue("app_installed", properties, current)
        } else if
            (appVersion != nil && version != nil && appVersion != version) ||
            (appBuild != nil && build != nil && appBuild != build)
        {
            var properties: [String: Any] = [:]
            properties["version"] = appVersion
            properties["build"] = appBuild
            properties["previous_version"] = version
            properties["previous_build"] = build
            enqueue("app_updated", properties, current)
        }
        firstLaunch = false
        version = appVersion ?? version
        build = appBuild ?? build
        save()
    }

    private func save() {
        guard saveTask == nil else { return }
        saveTask = platform.scheduler.schedule(after: 250) { [self] in
            saveTask = nil
            writeNow()
        }
    }

    private func writeNow() {
        saveTask?.cancel()
        saveTask = nil
        guard let store = platform.store else { return }
        var state: [String: Any] = [
            "anonymousId": anonymousId,
            "userId": userId ?? NSNull(),
            "traits": traits ?? NSNull(),
            "session": session?.json ?? NSNull(),
            "optedOut": optedOut,
        ]
        state["version"] = version
        state["build"] = build
        if let text = JSONValue.string(state) { store.write(storageName, text) }
        if let text = JSONValue.string(queue.map { $0.json }) { store.write("\(storageName)-queue", text) }
    }

    private func mergeTraits(_ newTraits: [String: Any]) {
        var merged = traits ?? [:]
        merged.merge(clean(newTraits)) { _, new in new }
        traits = merged
        traitsVersion += 1
    }

    // Sessions and events ---------------------------------------------------------------------

    private func ensureSession() -> Session {
        let now = platform.now()
        let timeout = Int64(options.sessionTimeoutMinutes) * 60_000
        if let current = session, now - current.last <= timeout {
            current.last = now
            return current
        }
        let started = Session(id: uuid(), started: now, last: now, firstScreen: screenName)
        session = started
        enqueue("session_started", [:], started)
        return started
    }

    private func enqueue(_ name: String, _ properties: [String: Any], _ current: Session) {
        queue.append(QueuedEvent(
            name: name,
            insertId: uuid(),
            time: isoTime(platform.now()),
            screen: screenName,
            properties: properties,
            userId: userId,
            anonymousId: anonymousId,
            sessionId: current.id,
            sessionStartedAt: isoTime(current.started)
        ))
        let limit = max(1, options.maxQueue)
        if queue.count > limit { queue.removeFirst(queue.count - limit) }
        save()
        scheduleFlush(queue.count >= flushAt ? 0 : Int64(options.flushIntervalSeconds) * 1000)
    }

    private func clean(_ properties: [String: Any]) -> [String: Any] {
        guard let value = JSONValue.sanitize(properties) as? [String: Any],
              let data = JSONValue.data(value)
        else { return [:] }
        if data.count > maxPropertiesBytes {
            warn("Event properties are over 32 KB and were dropped.")
            return [:]
        }
        return value
    }

    // Sending --------------------------------------------------------------------------------

    private func context(_ live: Session?) -> [String: Any] {
        let device = platform.device()
        var context: [String: Any] = [
            "platform": device.platform,
            "sdk": platform.sdk,
            "timezone": device.timezone,
            "language": device.language,
            "device_type": device.deviceType,
            "os_name": device.osName,
            "os_version": device.osVersion,
            "screen_width": device.screenWidth,
            "screen_height": device.screenHeight,
        ]
        context["device_model"] = device.deviceModel
        context["app_version"] = options.appVersion
        context["page_path"] = live?.firstScreen
        return context
    }

    /// One request's body: queued events share a person and session; with none, a heartbeat.
    private func body(_ events: [QueuedEvent]) -> [String: Any] {
        let head = events.first
        let current = session
        let sessionId = head?.sessionId ?? current?.id
        let startedAt = head?.sessionStartedAt ?? current.map { isoTime($0.started) }
        let live = current?.id == sessionId ? current : nil
        let person = anonymousId
        let isCurrentPerson = head == nil || head?.anonymousId == person
        let user = isCurrentPerson ? userId : events.last?.userId
        var body: [String: Any] = [
            "anonymous_id": head?.anonymousId ?? person,
            "sent_at": isoTime(platform.now()),
            "context": context(live),
            "events": events.map { $0.requestJSON },
        ]
        if let sessionId = sessionId, let startedAt = startedAt {
            body["session"] = ["id": sessionId, "started_at": startedAt]
        }
        if let user = user { body["user_id"] = user }
        if isCurrentPerson, let traits = traits { body["traits"] = traits }
        return body
    }

    private func nextBatch() -> [QueuedEvent] {
        guard let head = queue.first else { return [] }
        var batch: [QueuedEvent] = []
        for event in queue {
            if event.sessionId != head.sessionId || event.anonymousId != head.anonymousId || batch.count >= batchSize {
                break
            }
            batch.append(event)
        }
        return batch
    }

    private func post(_ body: [String: Any]) throws -> Response {
        guard let data = JSONValue.data(body) else { return Response(status: 400, text: "invalid JSON") }
        return try platform.transport.post(url: endpoint, key: key, body: data)
    }

    private func sendQueued() {
        while !stopped, !optedOut {
            let batch = nextBatch()
            if batch.isEmpty, !(identityPending && session != nil) { return }
            let traitsSent = traitsVersion
            let carriesIdentity = batch.isEmpty || batch[0].anonymousId == anonymousId
            let response: Response
            do {
                response = try post(body(batch))
            } catch {
                retryLater()
                return
            }
            let refused = (400 ... 499).contains(response.status) && response.status != 408 && response.status != 429
            let ok = (200 ... 299).contains(response.status)
            if !ok, !refused {
                retryLater()
                return
            }
            if refused { warn("Events were refused (\(response.status)): \(response.text)") }
            let sent = Set(batch.map { $0.insertId })
            queue.removeAll { sent.contains($0.insertId) }
            if ok, carriesIdentity, traitsVersion == traitsSent {
                traits = nil
                identityPending = false
            }
            failures = 0
            lastSent = platform.now()
            save()
        }
    }

    private func retryLater() {
        failures += 1
        scheduleFlush(min(60_000, Int64(1000) << Int64(min(failures, 6))), replace: true)
    }

    private func scheduleFlush(_ delay: Int64, replace: Bool = false) {
        guard !stopped else { return }
        if let pending = flushTask {
            if delay > 0, !replace { return }
            pending.cancel()
        }
        flushTask = platform.scheduler.schedule(after: delay) { [self] in
            flushTask = nil
            sendQueued()
        }
    }

    private func scheduleHeartbeat() {
        heartbeatTask = platform.scheduler.schedule(after: heartbeatMilliseconds) { [self] in
            heartbeatTask = nil
            guard inForeground, !stopped else { return }
            heartbeat()
            scheduleHeartbeat()
        }
    }

    /// Keeps an open app counted as online.
    private func heartbeat() {
        guard !optedOut, let current = session else { return }
        current.last = platform.now()
        if !queue.isEmpty || identityPending { return sendQueued() }
        if platform.now() - lastSent < heartbeatMilliseconds - 1000 { return }
        if (try? post(body([]))) != nil { lastSent = platform.now() }
    }

    private func warn(_ message: String) {
        if options.debug { platform.log("KissMyApps: \(message)") }
    }
}
