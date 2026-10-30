import Foundation

enum JSONValue {
    /// Turns app values into JSON: dictionaries, arrays, numbers, text, booleans, dates and nil.
    static func sanitize(_ value: Any) -> Any {
        let mirror = Mirror(reflecting: value)
        if mirror.displayStyle == .optional {
            guard let wrapped = mirror.children.first?.value else { return NSNull() }
            return sanitize(wrapped)
        }
        switch value {
        case is NSNull, is String:
            return value
        case let number as Double:
            return number.isFinite ? value : NSNull()
        case let number as Float:
            return number.isFinite ? value : NSNull()
        case is Bool, is Int, is Int8, is Int16, is Int32, is Int64, is UInt, is UInt8, is UInt16, is UInt32, is UInt64:
            return value
        case let number as NSNumber:
            return number.doubleValue.isFinite ? number : NSNull()
        case let date as Date:
            return isoTime(Int64((date.timeIntervalSince1970 * 1000).rounded()))
        case let url as URL:
            return url.absoluteString
        case let dictionary as [String: Any]:
            return dictionary.mapValues { sanitize($0) }
        case let array as [Any]:
            return array.map { sanitize($0) }
        default:
            return String(describing: value)
        }
    }

    static func data(_ object: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(object) else { return nil }
        return try? JSONSerialization.data(withJSONObject: object)
    }

    static func string(_ object: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object)
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func parse(_ text: String?) -> Any? {
        guard let data = text?.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    static func int64(_ value: Any?) -> Int64? {
        switch value {
        case let number as Int64: return number
        case let number as Int: return Int64(number)
        case let number as Double: return Int64(number)
        case let number as NSNumber: return number.int64Value
        default: return nil
        }
    }
}

private let wholeSeconds: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    return formatter
}()

/// 2026-10-30T09:59:00.123Z, from milliseconds since 1970.
func isoTime(_ milliseconds: Int64) -> String {
    let seconds = milliseconds / 1000
    let rest = milliseconds % 1000
    return wholeSeconds.string(from: Date(timeIntervalSince1970: TimeInterval(seconds))) + String(format: ".%03dZ", Int(rest))
}
