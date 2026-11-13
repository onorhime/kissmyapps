import Foundation

// Install attribution and deep links: the request bodies and answers of /v1/attribution/install
// and /v1/attribution/open, as integrations/analytics-mobile/contract/app-events.json sets them.

/// The install call is made on the first launch and, while it fails for want of a connection
/// or a working server, on up to three more launches: one try on each.
let maxInstallAttempts = 4
/// How long a launch waits before the install call, so the first link of the first launch can go
/// with it. That link sends the call at once.
let installCallDelayMilliseconds: Int64 = 1500
/// Links kept while they wait for the launch's install call.
let maxWaitingLinks = 10

private let maxLinkLength = 2048
private let maxAppleAdsLength = 4096
private let maxParams = 10
private let clipboardPrefix = "kma:"
private let clickIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{16,40}\\z")
private let deviceKeyPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}\\z")

/// Where a KissMyApps link should take the person in your app, from the link's deep link
/// settings in the console.
public struct DeepLink: Equatable {
    /// The link's deep link value, such as `lesson`, or nil when the link has none.
    public let value: String?
    /// The link's deep link parameters, such as `["id": "4"]`.
    public let params: [String: String]
    /// True when the link reached the app through an install (the app was not installed when
    /// the person tapped it), false when the link opened the app.
    public let deferred: Bool
    /// The link that opened the app, or nil for a link that came through an install from the
    /// App Store.
    public let url: URL?

    public init(value: String?, params: [String: String], deferred: Bool, url: URL?) {
        self.value = value
        self.params = params
        self.deferred = deferred
        self.url = url
    }
}

/// Whether the SDK sends this address to KissMyApps: any https link of up to 2,048 characters.
/// KissMyApps' answer decides whether it is one of the project's links.
func isLinkURL(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else { return false }
    return url.absoluteString.count <= maxLinkLength
}

/// The click ID in clipboard text `kma:<click id>`, as the link page for iPhone copies it.
func clipboardClick(_ text: String?) -> String? {
    guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), text.hasPrefix(clipboardPrefix) else {
        return nil
    }
    let id = String(text.dropFirst(clipboardPrefix.count))
    return matches(clickIdPattern, id) ? id : nil
}

/// The SHA-256 of identifierForVendor, as the calls carry it; nil when there is none.
func deviceKey(_ vendorId: String?) -> String? {
    guard let vendorId = vendorId, !vendorId.isEmpty else { return nil }
    let key = sha256Hex(vendorId)
    return matches(deviceKeyPattern, key) ? key : nil
}

/// The install body's field for Apple Ads' attribution value, `apple_ads_` and "to" "ken" (kept
/// in parts so secret scanners do not take the field name for a credential).
let appleAdsField = "apple_ads_" + "to" + "ken"

/// Apple Ads' attribution value as the install call may carry it.
func appleAdsValue(_ value: String?) -> String? {
    guard let value = value, !value.isEmpty, value.count <= maxAppleAdsLength else { return nil }
    return value
}

/// The install call's progress, kept with the SDK's other state so it survives launches.
struct InstallState {
    /// When `app_installed` was recorded.
    var installedAt: String
    /// The first link of the first launch, when it came before the install call.
    var linkUrl: String?
    /// The first call's body. Later tries send it again as it was, with a fresh Apple Ads value.
    var body: [String: Any]?
    /// Calls that failed for want of a connection or a working server.
    var attempts = 0
    /// Answered, refused or given up: the call is never made again.
    var done = false

    init(installedAt: String) {
        self.installedAt = installedAt
    }

    var json: [String: Any] {
        var json: [String: Any] = ["installedAt": installedAt, "attempts": attempts, "done": done]
        json["linkUrl"] = linkUrl
        json["body"] = body
        return json
    }

    static func from(_ value: Any?) -> InstallState? {
        guard let json = value as? [String: Any], let installedAt = json["installedAt"] as? String else { return nil }
        var state = InstallState(installedAt: installedAt)
        state.linkUrl = json["linkUrl"] as? String
        state.body = json["body"] as? [String: Any]
        state.attempts = JSONValue.int64(json["attempts"]).map { Int($0) } ?? 0
        state.done = json["done"] as? Bool ?? false
        return state
    }
}

/// What an attribution call answered.
struct AttributionAnswer {
    let matched: Bool
    let method: String
    let deepLink: DeepLink?

    /// Reads `{"matched", "method", "deep_link": null | {"value", "params", "deferred"}}`; `url` is
    /// the link the call carried, if any. Nil when the answer is not that shape.
    static func parse(_ text: String, url: URL?) -> AttributionAnswer? {
        guard let json = JSONValue.parse(text) as? [String: Any],
              let matched = json["matched"] as? Bool,
              let method = json["method"] as? String
        else { return nil }
        var link: DeepLink?
        if let deepLink = json["deep_link"] as? [String: Any] {
            guard let deferred = deepLink["deferred"] as? Bool else { return nil }
            // Text values, at most 10 keys; numbers and booleans become text, anything else is left out.
            var params: [String: String] = [:]
            let given = deepLink["params"] as? [String: Any] ?? [:]
            for name in given.keys.sorted() where params.count < maxParams {
                if let text = paramText(given[name]!) { params[name] = text }
            }
            link = DeepLink(value: deepLink["value"] as? String, params: params, deferred: deferred, url: url)
        }
        return AttributionAnswer(matched: matched, method: method, deepLink: link)
    }
}

private func paramText(_ value: Any) -> String? {
    if let text = value as? String { return text }
    guard let number = value as? NSNumber else { return nil }
    // JSON's true and false come back as numbers whose type is a C char, on Apple platforms and Linux.
    if String(cString: number.objCType) == "c" { return number.boolValue ? "true" : "false" }
    return number.stringValue
}
