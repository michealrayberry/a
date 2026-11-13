import SwiftUI

/// Large tabular countdown driven by the server-anchored clock. Ticks once a
/// second via TimelineView; the device wall clock never feeds the number.
@MainActor
struct CountdownView: View {
    let title: String
    let deadline: Date
    let clock: ServerClock
    let zone: String

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let remaining = clock.remaining(until: deadline)
            VStack(alignment: .leading, spacing: 8) {
                Text(title.uppercased())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.textSecondary)
                Text(remaining > 0 ? ServerClock.format(remaining) : "DEADLINE PASSED")
                    .font(.system(size: 96, weight: .bold, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(color(for: remaining))
                    .contentTransition(.numericText())
                Text("Due \(ISODate.time(deadline, zone: zone)) · server time")
                    .font(.callout)
                    .foregroundStyle(Theme.textSecondary)
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func color(for remaining: TimeInterval) -> Color {
        switch remaining {
        case ..<1: Theme.missed
        case ..<3600: Theme.late         // final hour
        case ..<(3 * 3600): Theme.grace  // final three hours
        default: Theme.textPrimary
        }
    }
}
