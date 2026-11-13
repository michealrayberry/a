import SwiftUI

/// Restrained palette matching the Android client and web surfaces:
/// near-black / white / gray with one steel-blue accent. Status colors signal
/// server state only, and are always paired with text and an icon.
enum Theme {
    static let ink = Color(hex: 0x0B0B0C)
    static let surface = Color(hex: 0x141416)
    static let surfaceHigh = Color(hex: 0x1E1E21)
    static let line = Color(hex: 0x2A2A2E)
    static let textPrimary = Color(hex: 0xF3F3F4)
    static let textSecondary = Color(hex: 0xA7A7AD)
    static let accent = Color(hex: 0x4C7DA6)

    static let timely = Color(hex: 0x3E8E5A)
    static let grace = Color(hex: 0xB08A2E)
    static let late = Color(hex: 0xC77B3A)
    static let missed = Color(hex: 0xB0503F)
    static let neutral = Color(hex: 0x6C6C72)

    /// tvOS is viewed from ~3 m; keep content inside the title-safe area.
    static let screenPadding: CGFloat = 80
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/// Maps a server status string to a label, SF Symbol and color.
struct StatusStyle {
    let label: String
    let symbol: String
    let color: Color

    init(_ raw: String?) {
        let s = (raw ?? "").uppercased()
        switch s {
        case "VERIFIED", "COMPLETE", "LOCKED", "ON_TIME", "PUBLISHED":
            label = Self.humanize(s); symbol = "checkmark.seal.fill"; color = Theme.timely
        case "SUBMITTED", "UNDER_REVIEW", "PENDING_REVIEW", "IN_PROGRESS":
            label = Self.humanize(s); symbol = "hourglass"; color = Theme.accent
        case "GRACE":
            label = "Grace"; symbol = "clock.badge.exclamationmark"; color = Theme.grace
        case "LATE":
            label = "Late"; symbol = "clock.badge.xmark"; color = Theme.late
        case "MISSED", "DEFICIENT", "VIOLATION_PENDING", "VIOLATION_ASSESSED", "REJECTED":
            label = Self.humanize(s); symbol = "xmark.octagon.fill"; color = Theme.missed
        case "EXCUSED", "NOT_APPLICABLE":
            label = Self.humanize(s); symbol = "minus.circle"; color = Theme.neutral
        case "NOT_STARTED", "OPEN":
            label = s == "OPEN" ? "Open" : "Not started"; symbol = "circle"; color = Theme.neutral
        case "":
            label = "—"; symbol = "questionmark.circle"; color = Theme.neutral
        default:
            label = Self.humanize(s); symbol = "questionmark.circle"; color = Theme.neutral
        }
    }

    static func humanize(_ raw: String) -> String {
        raw.replacingOccurrences(of: "_", with: " ").lowercased().capitalized(with: nil)
    }
}

struct StatusBadge: View {
    let status: String?

    var body: some View {
        let style = StatusStyle(status)
        Label(style.label, systemImage: style.symbol)
            .font(.callout.weight(.semibold))
            .foregroundStyle(style.color)
            .padding(.horizontal, 18)
            .padding(.vertical, 8)
            .background(style.color.opacity(0.15), in: Capsule())
            .accessibilityLabel("Status: \(style.label)")
    }
}

/// Shared loading / error / content scaffold with Siri Remote refresh.
struct LoadState<Value> {
    var value: Value?
    var error: String?
    var isLoading = false
}

struct ErrorPanel: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 72)).foregroundStyle(Theme.late)
            Text(message).font(.title3).multilineTextAlignment(.center).frame(maxWidth: 1100)
            Button("Retry", systemImage: "arrow.clockwise", action: retry)
        }
        .padding(Theme.screenPadding)
    }
}

extension View {
    /// Play/Pause on the Siri Remote reloads the current screen.
    func refreshOnPlayPause(_ action: @escaping () -> Void) -> some View {
        onPlayPauseCommand(perform: action)
    }
}
