import Foundation

/// Settings for `KissMyApps.start`. Every one has a default.
public struct KissMyAppsOptions {
    public static let defaultEndpoint = "https://events.kissmyapps.dev"

    /// The app's version and build number. Read from the app's Info.plist when left out.
    public var appVersion: String?
    public var build: String?
    public var endpoint: String
    /// A session ends after this long in the background or without events.
    public var sessionTimeoutMinutes: Int
    /// How often queued events are sent while the app is open.
    public var flushIntervalSeconds: Int
    /// The most events kept while offline; the oldest go first.
    public var maxQueue: Int
    /// Record installs, updates, opens and backgrounding.
    public var trackLifecycle: Bool
    /// Print refused events and other problems to the console.
    public var debug: Bool
    /// Read the clipboard once, on the first launch, for the link the person tapped before
    /// installing (`kma:` and a click ID, copied by the link's page when "Clipboard handoff for
    /// iPhone" is on in the console). iOS shows the person that the app pasted, and from iOS 16
    /// asks them first. Off by default: the SDK never reads the clipboard otherwise.
    public var clipboardHandoff: Bool

    public init(
        appVersion: String? = nil,
        build: String? = nil,
        endpoint: String = KissMyAppsOptions.defaultEndpoint,
        sessionTimeoutMinutes: Int = 30,
        flushIntervalSeconds: Int = 10,
        maxQueue: Int = 1000,
        trackLifecycle: Bool = true,
        debug: Bool = false,
        clipboardHandoff: Bool = false
    ) {
        self.appVersion = appVersion
        self.build = build
        self.endpoint = endpoint
        self.sessionTimeoutMinutes = sessionTimeoutMinutes
        self.flushIntervalSeconds = flushIntervalSeconds
        self.maxQueue = maxQueue
        self.trackLifecycle = trackLifecycle
        self.debug = debug
        self.clipboardHandoff = clipboardHandoff
    }
}
