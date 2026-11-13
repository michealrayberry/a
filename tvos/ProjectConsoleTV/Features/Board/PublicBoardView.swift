import SwiftUI
import Charts
import UIKit

/// Public tracker board, built for an always-on TV. It uses only the public
/// read API, so it shows exactly what michealrayberry.com shows — nothing the
/// AP has not published — and it works without signing in.
@MainActor
struct PublicBoardView: View {
    @Environment(SessionModel.self) private var session
    @State private var status: PublicStatus?
    @State private var weights: [PublicWeight] = []
    @State private var days: [PublicDay] = []
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 56) {
                if let status {
                    headline(status)
                    progress(status)
                    if weights.count >= 2 { chart(status) }
                    recentDays
                    footer(status)
                } else if let error {
                    ErrorPanel(message: error) { Task { await load() } }
                } else {
                    ProgressView("Loading public record…")
                }
            }
            .padding(Theme.screenPadding)
        }
        .task(id: session.refreshToken) {
            // Public data changes only when the AP publishes; every 5 minutes is plenty.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(300))
            }
        }
        .refreshOnPlayPause { Task { await load() } }
        // Keep the TV awake while the board is on screen.
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private func headline(_ s: PublicStatus) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 8) {
                Text(s.project).font(.title2).foregroundStyle(Theme.textSecondary)
                if let day = s.currentProjectDay {
                    Text("Day \(day)").font(.system(size: 76, weight: .bold))
                }
            }
            Spacer()
            if let latest = s.latestDayStatus { StatusBadge(status: latest) }
        }
    }

    private func progress(_ s: PublicStatus) -> some View {
        let current = s.currentVerifiedWeight
        let span = s.startWeight - s.goalWeight
        let lost = current.map { s.startWeight - $0 } ?? 0
        let fraction = span > 0 ? min(max(lost / span, 0), 1) : 0
        return VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .bottom, spacing: 80) {
                metric("Current (verified)", current.map { fmt($0, s.unit) } ?? "—", big: true)
                metric("Start", fmt(s.startWeight, s.unit))
                metric("Goal", fmt(s.goalWeight, s.unit))
                metric("Change", s.totalVerifiedChange.map { (($0 > 0) ? "+" : "") + fmt($0, s.unit) } ?? "—")
                metric("To goal", current.map { fmt(max($0 - s.goalWeight, 0), s.unit) } ?? "—")
            }
            ProgressView(value: fraction)
                .tint(Theme.accent)
                .accessibilityLabel("Progress to goal \(Int(fraction * 100)) percent")
            Text("\(Int((fraction * 100).rounded()))% of the way from \(fmt(s.startWeight, s.unit)) to \(fmt(s.goalWeight, s.unit))")
                .font(.callout).foregroundStyle(Theme.textSecondary)
        }
    }

    private func chart(_ s: PublicStatus) -> some View {
        Chart {
            ForEach(weights) { w in
                if let date = ISODate.parse(w.measuredAt) {
                    LineMark(x: .value("Date", date), y: .value("Weight", w.weight))
                        .foregroundStyle(Theme.accent)
                    PointMark(x: .value("Date", date), y: .value("Weight", w.weight))
                        .foregroundStyle(Theme.accent)
                }
            }
            RuleMark(y: .value("Goal", s.goalWeight))
                .foregroundStyle(Theme.timely)
                .lineStyle(StrokeStyle(lineWidth: 2, dash: [8, 6]))
                .annotation(position: .top, alignment: .leading) {
                    Text("Goal \(fmt(s.goalWeight, s.unit))").font(.caption).foregroundStyle(Theme.timely)
                }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .frame(height: 420)
        .accessibilityLabel("Verified weight over time")
    }

    private var recentDays: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Recent published days").font(.title2.bold())
            if days.isEmpty {
                Text("Nothing published yet.").foregroundStyle(Theme.textSecondary)
            }
            // Focusable so the remote can scroll the board.
            ForEach(days.prefix(10)) { d in
                Button {} label: {
                    HStack(spacing: 32) {
                        Text("Day \(d.dayNumber)").font(.title3.bold()).frame(width: 200, alignment: .leading)
                        Text(d.localDate).monospacedDigit().foregroundStyle(Theme.textSecondary)
                        Spacer()
                        StatusBadge(status: d.overallStatus)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func footer(_ s: PublicStatus) -> some View {
        Text("Public record · verified data only · last updated \(ISODate.display(s.lastUpdated, zone: session.projectZone)) · Play/Pause refreshes")
            .font(.caption).foregroundStyle(Theme.textSecondary)
    }

    private func metric(_ label: String, _ value: String, big: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
            Text(value).font(big ? .system(size: 72, weight: .bold) : .title2.bold()).monospacedDigit()
        }
    }

    private func fmt(_ value: Double, _ unit: String) -> String {
        String(format: "%.1f %@", value, unit)
    }

    private func load() async {
        do {
            let client = try session.publicClient()
            let slug = AppSettings.publicSlug
            async let s = client.publicStatus(slug: slug)
            async let w = client.publicWeights(slug: slug)
            async let d = client.publicDays(slug: slug)
            (status, weights, days) = try await (s, w, d)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
