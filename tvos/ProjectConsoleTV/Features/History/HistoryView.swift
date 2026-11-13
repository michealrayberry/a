import SwiftUI

/// Project-day history (server record). Select a day to drill into its
/// requirements and audit trail.
@MainActor
struct HistoryView: View {
    @Environment(SessionModel.self) private var session
    @State private var state = LoadState<[ProjectDay]>()

    var body: some View {
        NavigationStack {
            Group {
                if let days = state.value {
                    if days.isEmpty {
                        ContentUnavailableView("No project days yet", systemImage: "calendar.badge.exclamationmark")
                    } else {
                        List(days) { day in
                            NavigationLink(value: day) { DayRow(day: day) }
                        }
                    }
                } else if let error = state.error {
                    ErrorPanel(message: error) { Task { await load() } }
                } else {
                    ProgressView("Loading history…")
                }
            }
            .navigationTitle("History")
            .navigationDestination(for: ProjectDay.self) { DayDetailView(day: $0) }
        }
        .task(id: session.refreshToken) { await load() }
        .refreshOnPlayPause { Task { await load() } }
    }

    private func load() async {
        do { state.value = try await session.client().history(); state.error = nil }
        catch { state.error = session.handle(error) }
    }
}

struct DayRow: View {
    let day: ProjectDay

    var body: some View {
        HStack(spacing: 32) {
            Text("Day \(day.dayNumber)").font(.title3.bold()).frame(width: 200, alignment: .leading)
            Text(day.localDate).monospacedDigit().foregroundStyle(Theme.textSecondary)
            Spacer()
            if day.publicStatus != "PRIVATE" {
                Label("Public", systemImage: "globe").font(.caption).foregroundStyle(Theme.textSecondary)
            }
            StatusBadge(status: day.overallStatus)
        }
        .padding(.vertical, 8)
    }
}

@MainActor
struct DayDetailView: View {
    @Environment(SessionModel.self) private var session
    let day: ProjectDay
    @State private var state = LoadState<DayDetailResponse>()

    private var zone: String { session.projectZone }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                HStack {
                    Text("Day \(day.dayNumber) · \(day.localDate)").font(.largeTitle.bold())
                    Spacer()
                    StatusBadge(status: day.overallStatus)
                }
                if let detail = state.value {
                    Text("Requirements").font(.title2.bold())
                    ForEach(detail.requirements) { req in
                        Button {} label: { RequirementCard(requirement: req, zone: zone) }
                            .buttonStyle(.card)
                    }
                    Text("Audit trail").font(.title2.bold()).padding(.top, 24)
                    if detail.audit.isEmpty {
                        Text("No audit events for this day.").foregroundStyle(Theme.textSecondary)
                    }
                    ForEach(detail.audit) { event in
                        Button {} label: { AuditRow(event: event, zone: zone) }
                            .buttonStyle(.plain)
                    }
                } else if let error = state.error {
                    ErrorPanel(message: error) { Task { await load() } }
                } else {
                    ProgressView()
                }
            }
            .padding(Theme.screenPadding)
        }
        .task { await load() }
        .refreshOnPlayPause { Task { await load() } }
    }

    private func load() async {
        do { state.value = try await session.client().day(id: day.id); state.error = nil }
        catch { state.error = session.handle(error) }
    }
}

struct AuditRow: View {
    let event: AuditEvent
    let zone: String

    var body: some View {
        HStack(alignment: .top, spacing: 24) {
            Text(ISODate.display(event.serverTimestamp, zone: zone, style: .standard))
                .monospacedDigit()
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 520, alignment: .leading)
            VStack(alignment: .leading, spacing: 6) {
                Text("\(event.actorRole) · \(StatusStyle.humanize(event.action))").font(.headline)
                if event.previousState != nil || event.newState != nil {
                    Text("\(event.previousState ?? "—") → \(event.newState ?? "—")")
                        .font(.callout).foregroundStyle(Theme.textSecondary)
                }
                if let reason = event.reason { Text(reason).font(.callout) }
            }
        }
        .padding(.vertical, 8)
    }
}
