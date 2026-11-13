import CommonCrypto
import Flutter
import UIKit
#if canImport(AdServices)
import AdServices
#endif

/// Tells the Dart side about the device and the app, the same way the iOS SDK does; asks iOS
/// for time to send what is queued when the app leaves the screen; reads what install
/// attribution needs (the device key, the Apple Ads token, a clipboard handoff); and passes on
/// the Universal Links that open the app. No advertising identifier, no tracking prompt.
public final class KissMyAppsPlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
    private var started = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var deadline: DispatchWorkItem?
    private var sink: FlutterEventSink?
    // Links that came before the Dart side listened.
    private var waitingLinks: [String] = []
    // The link that opened the app, kept until the Dart side asks for it once.
    private var launchLink: String?
    private var launchLinkRead = false

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(name: "kissmyapps", binaryMessenger: registrar.messenger())
        let instance = KissMyAppsPlugin()
        registrar.addMethodCallDelegate(instance, channel: channel)
        let links = FlutterEventChannel(name: "kissmyapps/links", binaryMessenger: registrar.messenger())
        links.setStreamHandler(instance)
        // Universal Links and URL schemes reach plugins through the app delegate.
        registrar.addApplicationDelegate(instance)
        let center = NotificationCenter.default
        center.addObserver(
            instance, selector: #selector(didEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil
        )
        center.addObserver(
            instance, selector: #selector(willEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil
        )
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "info":
            started = true
            result(info())
        case "releaseBackground":
            endBackgroundTask()
            result(nil)
        case "initialLink":
            launchLinkRead = true
            result(launchLink)
            launchLink = nil
        case "attributionInfo":
            let arguments = call.arguments as? [String: Any] ?? [:]
            attributionInfo(
                install: arguments["install"] as? Bool ?? false,
                clipboard: arguments["clipboard"] as? Bool ?? false,
                result: result
            )
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    // Links -------------------------------------------------------------------------------

    /// A Universal Link that opened the app. Returns false so Flutter and other plugins see it too.
    public func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([Any]) -> Void
    ) -> Bool {
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL {
            received(url.absoluteString)
        }
        return false
    }

    /// A URL scheme link; the Dart side sends only https links. Returns false for the same reason.
    public func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        received(url.absoluteString)
        return false
    }

    private func received(_ link: String) {
        if !launchLinkRead && launchLink == nil {
            launchLink = link
        } else if let sink = sink {
            sink(link)
        } else if waitingLinks.count < 10 {
            waitingLinks.append(link)
        }
    }

    public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        sink = events
        // The opening link, if the Dart side has not asked for it yet, stays for initialLink.
        for link in waitingLinks { events(link) }
        waitingLinks.removeAll()
        return nil
    }

    public func onCancel(withArguments arguments: Any?) -> FlutterError? {
        sink = nil
        return nil
    }

    // Attribution ---------------------------------------------------------------------------

    /// The device key; on install tries the Apple Ads token, fetched each time as it expires,
    /// and with clipboard handoff on, a `kma:` click ID from the clipboard.
    private func attributionInfo(install: Bool, clipboard: Bool, result: @escaping FlutterResult) {
        var info: [String: Any] = [:]
        // SHA-256 of identifierForVendor as UIKit writes it; the identifier never leaves the phone.
        if let vendor = UIDevice.current.identifierForVendor?.uuidString {
            info["deviceKey"] = KissMyAppsPlugin.sha256Hex(vendor)
        }
        if install, clipboard, let click = KissMyAppsPlugin.clipboardClick() {
            info["clipboardClick"] = click
        }
        guard install else {
            result(info)
            return
        }
        let fromMain = info
        // The token comes from a system service; keep it off the main thread.
        DispatchQueue.global(qos: .utility).async {
            var answer = fromMain
            if let ads = KissMyAppsPlugin.appleAdsToken() { answer["appleAdsToken"] = ads }
            DispatchQueue.main.async { result(answer) }
        }
    }

    /// iOS asks the person before an app reads what another app copied; only with handoff on.
    private static func clipboardClick() -> String? {
        let board = UIPasteboard.general
        guard board.hasStrings, let text = board.string else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("kma:") else { return nil }
        return String(trimmed.dropFirst(4))
    }

    private static func appleAdsToken() -> String? {
        #if canImport(AdServices)
        if #available(iOS 14.3, *) {
            // Fails on the simulator and when Apple's service is unavailable: nothing then.
            return try? AAAttribution.attributionToken()
        }
        #endif
        return nil
    }

    private static func sha256Hex(_ text: String) -> String {
        let bytes = Array(text.utf8)
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        _ = bytes.withUnsafeBufferPointer { buffer in
            CC_SHA256(buffer.baseAddress, CC_LONG(buffer.count), &digest)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // Device --------------------------------------------------------------------------------

    private func info() -> [String: Any] {
        let device = UIDevice.current
        let bounds = UIScreen.main.bounds
        let bundle = Bundle.main.infoDictionary ?? [:]
        var info: [String: Any] = [
            "osName": device.systemName,
            "osVersion": device.systemVersion,
            "deviceType": device.userInterfaceIdiom == .pad ? "tablet" : "mobile",
            "screenWidth": Int(bounds.width.rounded()),
            "screenHeight": Int(bounds.height.rounded()),
            "timezone": TimeZone.current.identifier,
            "language": (Locale.preferredLanguages.first ?? Locale.current.identifier)
                .replacingOccurrences(of: "_", with: "-"),
            "storageDirectory": storageDirectory().path,
        ]
        if let model = modelIdentifier() { info["deviceModel"] = model }
        if let version = bundle["CFBundleShortVersionString"] as? String { info["appVersion"] = version }
        if let build = bundle["CFBundleVersion"] as? String { info["build"] = build }
        return info
    }

    /// The hardware model, such as iPhone15,4.
    private func modelIdentifier() -> String? {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var system = utsname()
        uname(&system)
        let machine = withUnsafeBytes(of: &system.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
        return machine.isEmpty ? nil : machine
    }

    /// Application Support/KissMyApps, left out of backups so a restored phone counts as a
    /// new install.
    private func storageDirectory() -> URL {
        let manager = FileManager.default
        let base = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? manager.temporaryDirectory
        var directory = base.appendingPathComponent("KissMyApps", isDirectory: true)
        try? manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        return directory
    }

    // The Dart side sends what is queued once the app has left; iOS gives it up to 25
    // seconds, until it says it is done.
    @objc private func didEnterBackground() {
        guard started, backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "KissMyApps") { [weak self] in
            self?.endBackgroundTask()
        }
        let deadline = DispatchWorkItem { [weak self] in self?.endBackgroundTask() }
        self.deadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: deadline)
    }

    @objc private func willEnterForeground() {
        endBackgroundTask()
    }

    private func endBackgroundTask() {
        deadline?.cancel()
        deadline = nil
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
