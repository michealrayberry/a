import SwiftUI

/// Today: server-calculated project day, next deadline countdown, and the
/// requirement cards. Read-only by design — see `RequirementDetailView`.
@MainActor
struct TodayView: View {
    @Environment(SessionModel.self) private var session
    @State private var state = LoadState<TodayResponse>()
    @State private var selected: Requirement?

    var body: some View {
        Group {
            if let today = state.value {
                content(today)
            } else if let error = state.error {
                ErrorPanel(message: error) { Task { await load() } }
            } else {
                ProgressView("Loading today…")
            }
        }
        // Re-sync every minute while visible, so a deadline sweep or an AP
        // verification shows up without touching the remote.
        .task(id: session.refreshToken) {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .refreshOnPlayPause { Task { await load() } }
        .sheet(item: $selected) { req in
            RequirementDetailView(requirement: req, zone: state.value?.timeZone ?? session.projectZone)
        }
    }

    @ViewBuilder
    private func content(_ today: TodayResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 48) {
                header(today)
                if let clock = session.clock, let next = nextDeadline(today) {
                    CountdownView(title: next.title, deadline: next.date, clock: clock, zone: today.timeZone)
                }
                if let error = state.error {
                    Label("Showing last sync. \(error)", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Theme.late)
                }
                requirementsGrid(today)
                Text("Play/Pause refreshes · Select a card for details · Evidence is submitted from the phone app")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }
            .padding(Theme.screenPadding)
        }
    }

    private func header(_ today: TodayResponse) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Day \(today.dayNumber)").font(.system(size: 76, weight: .bold))
                Text(today.localDate + " · " + today.timeZone)
                    .font(.title3)
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 12) {
                StatusBadge(status: today.overallStatus)
                let outstanding = today.requirements.filter { $0.isMandatory && $0.isOutstanding }.count
                Text(outstanding == 0 ? "No mandatory items outstanding" : "\(outstanding) mandatory item\(outstanding == 1 ? "" : "s") outstanding")
                    .font(.headline)
                    .foregroundStyle(outstanding == 0 ? Theme.timely : Theme.late)
            }
        }
    }

    private func requirementsGrid(_ today: TodayResponse) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 520), spacing: 48)], spacing: 48) {
            ForEach(sorted(today.requirements)) { req in
                Button { selected = req } label: { RequirementCard(requirement: req, zone: today.timeZone) }
                    .buttonStyle(.card)
            }
        }
    }

    /// Outstanding mandatory items first, then by deadline.
    private func sorted(_ reqs: [Requirement]) -> [Requirement] {
        reqs.sorted { a, b in
            let ra = (a.isMandatory && a.isOutstanding) ? 0 : 1
            let rb = (b.isMandatory && b.isOutstanding) ? 0 : 1
            return ra != rb ? ra < rb : a.deadlineAt < b.deadlineAt
        }
    }

    /// The earliest deadline still owed; falls back to the day's close.
    private func nextDeadline(_ today: TodayResponse) -> (title: String, date: Date)? {
        let now = session.clock?.now() ?? .now
        let owed = today.requirements
            .filter { $0.isMandatory && $0.isOutstanding }
            .compactMap { r in ISODate.parse(r.deadlineAt).map { (r.name, $0) } }
            .filter { $0.1 > now }
            .min { $0.1 < $1.1 }
        if let owed { return ("Next deadline — \(owed.0)", owed.1) }
        return ISODate.parse(today.dayDeadline).map { ("Day closes", $0) }
    }

    private func load() async {
        state.isLoading = true
        defer { state.isLoading = false }
        do {
            let today = try await session.client().today()
            session.sync(serverTime: today.serverTime, timeZone: today.timeZone)
            state.value = today
            state.error = nil
        } catch {
            state.error = session.handle(error)
        }
    }
}

struct RequirementCard: View {
    let requirement: Requirement
    let zone: String

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: icon).font(.title2)
                Text(requirement.name).font(.title3.bold()).lineLimit(2)
                Spacer(minLength: 0)
            }
            HStack(spacing: 12) {
                StatusBadge(status: requirement.status)
                if let t = requirement.timeliness, !t.isEmpty, t != "NOT_SUBMITTED" { StatusBadge(status: t) }
            }
            Text(requirement.isMandatory ? "Mandatory · due \(ISODate.time(requirement.deadlineAt, zone: zone))"
                                         : "Optional · due \(ISODate.time(requirement.deadlineAt, zone: zone))")
                .font(.callout)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(32)
        .frame(maxWidth: .infinity, minHeight: 220, alignment: .topLeading)
        .background(Theme.surface)
    }

    private var icon: String {
        switch requirement.evidenceType.uppercased() {
        case "VIDEO": "video.fill"
        case "PHOTO": "camera.fill"
        case "WEIGHT": "scalemass.fill"
        case "EXTERNAL_LINK": "link"
        case "TRACKING": "list.bullet.clipboard"
        default: "doc"
        }
    }
}

/// Requirement detail. Apple TV has no camera and no file system, so evidence
/// capture and submission stay on the phone client — the TV never offers a
/// "mark complete" control (evidence before status, blueprint §3.3).
@MainActor
struct RequirementDetailView: View {
    let requirement: Requirement
    let zone: String

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            Text(requirement.name).font(.largeTitle.bold())
            HStack(spacing: 16) {
                StatusBadge(status: requirement.status)
                if let t = requirement.timeliness { StatusBadge(status: t) }
            }
            Grid(alignment: .leading, horizontalSpacing: 48, verticalSpacing: 16) {
                row("Code", requirement.requirementCode)
                row("Evidence type", StatusStyle.humanize(requirement.evidenceType))
                row("Mandatory", requirement.isMandatory ? "Yes" : "No")
                row("Deadline", ISODate.display(requirement.deadlineAt, zone: zone))
                row("Grace", requirement.grace ?? "None")
                row("Server received", ISODate.display(requirement.serverReceivedAt, zone: zone, style: .standard))
                row("Verified", ISODate.display(requirement.verifiedAt, zone: zone))
            }
            if requirement.isOutstanding {
                Label("Submit this from the Project Console phone app. Only the server's received time counts toward the deadline.",
                      systemImage: "iphone")
                    .font(.headline)
                    .foregroundStyle(Theme.late)
            }
        }
        .padding(Theme.screenPadding)
        .frame(maxWidth: 1400, alignment: .leading)
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(Theme.textSecondary)
            Text(value).monospacedDigit()
        }
        .font(.title3)
    }
}
