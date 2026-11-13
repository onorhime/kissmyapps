import CommonCrypto
import Foundation
import UIKit
#if canImport(AdServices)
import AdServices
#endif

/// The optional native part of @kissmyappss/react-native on iOS: what the install call needs
/// that JavaScript cannot read. The SDK works without it, minus these fields.
///
/// - `deviceKey`: SHA-256 hex of identifierForVendor. The identifier itself never leaves the phone.
/// - `appleAdsToken`: AAAttribution.attributionToken(), iOS 14.3 and later, first launch only.
/// - `clipboardClick`: the click ID after `kma:` on the clipboard, only when the app turned
///   clipboard handoff on (iOS asks the person before an app reads another app's copy).
///
/// No advertising identifier, no tracking prompt.
@objc(KissMyAppsAttribution)
final class KissMyAppsAttribution: NSObject {
    @objc static func requiresMainQueueSetup() -> Bool { false }

    @objc(getAttributionInfo:resolver:rejecter:)
    func getAttributionInfo(
        _ request: NSDictionary,
        resolver resolve: @escaping (Any?) -> Void,
        rejecter _: @escaping (String?, String?, Error?) -> Void
    ) {
        let install = request["install"] as? Bool ?? false
        let clipboard = request["clipboard"] as? Bool ?? false
        DispatchQueue.main.async {
            var info: [String: Any] = [:]
            if let vendor = UIDevice.current.identifierForVendor?.uuidString {
                info["deviceKey"] = KissMyAppsAttribution.sha256Hex(vendor)
            }
            if install, clipboard, let click = KissMyAppsAttribution.clipboardClick() {
                info["clipboardClick"] = click
            }
            let fromMain = info
            // The token comes from a system service; keep it off the main thread.
            DispatchQueue.global(qos: .utility).async {
                var result = fromMain
                if install, let ads = KissMyAppsAttribution.appleAdsToken() {
                    result["appleAdsToken"] = ads
                }
                resolve(result)
            }
        }
    }

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

    static func sha256Hex(_ text: String) -> String {
        let bytes = Array(text.utf8)
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        _ = bytes.withUnsafeBufferPointer { buffer in
            CC_SHA256(buffer.baseAddress, CC_LONG(buffer.count), &digest)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
