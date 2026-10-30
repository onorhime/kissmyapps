import Foundation
#if os(iOS)
import UIKit
#endif

/// The hardware model, such as iPhone15,4.
func modelIdentifier() -> String? {
    if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
    var system = utsname()
    uname(&system)
    let machine = withUnsafeBytes(of: &system.machine) { bytes in
        String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
    }
    return machine.isEmpty ? nil : machine
}

func preferredLanguage() -> String {
    (Locale.preferredLanguages.first ?? Locale.current.identifier).replacingOccurrences(of: "_", with: "-")
}

/// Where the SDK keeps its IDs and offline queue: Application Support, left out of backups so
/// a restored phone counts as a new install.
func storageDirectory() -> URL {
    let manager = FileManager.default
    let base = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? manager.temporaryDirectory
    #if os(iOS)
    var directory = base.appendingPathComponent("KissMyApps", isDirectory: true)
    #else
    var directory = base
        .appendingPathComponent(Bundle.main.bundleIdentifier ?? "app", isDirectory: true)
        .appendingPathComponent("KissMyApps", isDirectory: true)
    #endif
    try? manager.createDirectory(at: directory, withIntermediateDirectories: true)
    #if os(iOS) || os(macOS)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? directory.setResourceValues(values)
    #endif
    return directory
}

#if os(iOS)
/// Call on the main thread.
func currentDevice() -> DeviceInfo {
    let device = UIDevice.current
    let bounds = UIScreen.main.bounds
    return DeviceInfo(
        platform: "ios",
        osName: device.systemName,
        osVersion: device.systemVersion,
        deviceType: device.userInterfaceIdiom == .pad ? "tablet" : "mobile",
        deviceModel: modelIdentifier(),
        screenWidth: Int(bounds.width.rounded()),
        screenHeight: Int(bounds.height.rounded()),
        timezone: TimeZone.current.identifier,
        language: preferredLanguage()
    )
}

/// Follows the app between foreground and background, and asks iOS for time to send what is
/// queued when the app leaves.
final class AppLifecycle: NSObject {
    private let client: Client
    private let device: DeviceBox
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    init(client: Client, device: DeviceBox) {
        self.client = client
        self.device = device
        super.init()
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil
        )
        if UIApplication.shared.applicationState != .background { didBecomeActive() }
    }

    @objc private func didBecomeActive() {
        device.value = currentDevice()
        client.foreground()
    }

    @objc private func didEnterBackground() {
        if backgroundTask == .invalid {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "KissMyApps") { [weak self] in
                self?.endBackgroundTask()
            }
        }
        client.background()
        client.afterPendingWork { [weak self] in
            DispatchQueue.main.async { self?.endBackgroundTask() }
        }
    }

    private func endBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }
}
#else
func currentDevice() -> DeviceInfo {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return DeviceInfo(
        platform: "ios",
        osName: "macOS",
        osVersion: "\(version.majorVersion).\(version.minorVersion)",
        deviceType: "mobile",
        deviceModel: modelIdentifier(),
        screenWidth: 0,
        screenHeight: 0,
        timezone: TimeZone.current.identifier,
        language: preferredLanguage()
    )
}
#endif

#if canImport(SwiftUI) && os(iOS)
import SwiftUI

public extension View {
    /// Records a screen view each time this view appears: `.kmaScreen("Lesson")`.
    func kmaScreen(_ name: String, properties: [String: Any] = [:]) -> some View {
        onAppear { KissMyApps.screen(name, properties: properties) }
    }
}
#endif
