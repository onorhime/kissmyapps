import Flutter
import UIKit

/// Tells the Dart side about the device and the app, the same way the iOS SDK does, and
/// asks iOS for time to send what is queued when the app leaves the screen.
public final class KissMyAppsPlugin: NSObject, FlutterPlugin {
    private var started = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var deadline: DispatchWorkItem?

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(name: "kissmyapps", binaryMessenger: registrar.messenger())
        let instance = KissMyAppsPlugin()
        registrar.addMethodCallDelegate(instance, channel: channel)
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
        default:
            result(FlutterMethodNotImplemented)
        }
    }

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
