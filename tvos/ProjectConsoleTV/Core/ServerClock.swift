import Foundation

/// Server-authoritative clock — the tvOS counterpart of the Android
/// `ServerCountdown`.
///
/// At each sync we store the server's "now" alongside a monotonic device
/// timestamp. The displayed time is the server anchor plus monotonic elapsed
/// time, so changing the Apple TV's clock cannot move a deadline countdown.
/// The true timeliness verdict is still made by the server at submission.
struct ServerClock: Equatable, Sendable {
    let serverAnchor: Date
    let monotonicAnchor: UInt64   // nanoseconds

    init(serverTime: Date, monotonicNow: UInt64 = ServerClock.monotonicNanos()) {
        self.serverAnchor = serverTime
        self.monotonicAnchor = monotonicNow
    }

    /// Best current estimate of server time.
    func now(monotonicNow: UInt64 = ServerClock.monotonicNanos()) -> Date {
        let elapsed = Double(monotonicNow &- monotonicAnchor) / 1_000_000_000
        return serverAnchor.addingTimeInterval(elapsed)
    }

    /// Seconds remaining until `deadline`; never negative.
    func remaining(until deadline: Date, monotonicNow: UInt64 = ServerClock.monotonicNanos()) -> TimeInterval {
        max(0, deadline.timeIntervalSince(now(monotonicNow: monotonicNow)))
    }

    /// CLOCK_MONOTONIC on Darwin keeps counting while the device sleeps and
    /// cannot be changed by the user.
    static func monotonicNanos() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) }

    /// HH:MM:SS for a tabular countdown.
    static func format(_ interval: TimeInterval) -> String {
        let total = Int(interval.rounded(.down))
        return String(format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
    }
}

/// Parses the server's ISO-8601 timestamps (Luxon emits fractional seconds and
/// either `Z` or a numeric offset).
enum ISODate {
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ string: String?) -> Date? {
        guard let string else { return nil }
        return fractional.date(from: string) ?? plain.date(from: string)
    }

    /// Formats an instant in the PROJECT time zone, never the TV's zone.
    static func display(_ string: String?, zone: String, style: Date.FormatStyle.TimeStyle = .shortened) -> String {
        guard let date = parse(string) else { return "—" }
        var format = Date.FormatStyle(date: .abbreviated, time: style)
        format.timeZone = TimeZone(identifier: zone) ?? .current
        return date.formatted(format)
    }

    static func time(_ string: String?, zone: String) -> String {
        guard let date = parse(string) else { return "—" }
        return time(date, zone: zone)
    }

    static func time(_ date: Date, zone: String) -> String {
        var format = Date.FormatStyle(date: .omitted, time: .shortened)
        format.timeZone = TimeZone(identifier: zone) ?? .current
        return date.formatted(format) + " " + (TimeZone(identifier: zone)?.abbreviation(for: date) ?? "")
    }
}
