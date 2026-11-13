import SwiftUI

/// Notices from the AP / system. The participant can acknowledge receipt —
/// acknowledging records that it was read; it does not dispute or close anything.
@MainActor
struct NoticesView: View {
    @Environment(SessionModel.self) private var session
    @State private var state = LoadState<[Notice]>()
    @State private var selected: Notice?

    var body: some View {
        NavigationStack {
            Group {
                if let notices = state.value {
                    if notices.isEmpty {
                        ContentUnavailableView("No notices", systemImage: "tray")
                    } else {
                        List(notices) { notice in
                            Button { selected = notice } label: { NoticeRow(notice: notice) }
                        }
                    }
                } else if let error = state.error {
                    ErrorPanel(message: error) { Task { await load() } }
                } else {
                    ProgressView("Loading notices…")
                }
            }
            .navigationTitle(title)
        }
        .task(id: session.refreshToken) { await load() }
        .refreshOnPlayPause { Task { await load() } }
        .sheet(item: $selected) { notice in
            NoticeDetailView(notice: notice) { await acknowledge(notice) }
        }
    }

    private var title: String {
        let open = state.value?.filter { !$0.isAcknowledged }.count ?? 0
        return open == 0 ? "Notices" : "Notices · \(open) unacknowledged"
    }

    private func load() async {
        do { state.value = try await session.client().notices(); state.error = nil }
        catch { state.error = session.handle(error) }
    }

    private func acknowledge(_ notice: Notice) async {
        do {
            try await session.client().acknowledgeNotice(id: notice.id)
            selected = nil
            await load()
        } catch {
            state.error = session.handle(error)
        }
    }
}

struct NoticeRow: View {
    @Environment(SessionModel.self) private var session
    let notice: Notice
    private var zone: String { session.projectZone }

    var body: some View {
        HStack(spacing: 24) {
            Image(systemName: notice.isAcknowledged ? "envelope.open" : "envelope.badge.fill")
                .foregroundStyle(notice.isAcknowledged ? Theme.neutral : Theme.late)
                .font(.title2)
            VStack(alignment: .leading, spacing: 6) {
                Text(notice.title).font(.title3.bold())
                Text("\(StatusStyle.humanize(notice.type)) · from \(notice.issuedByRole) · \(ISODate.display(notice.issuedAt, zone: zone))")
                    .font(.callout).foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            if notice.requiresResponse && !notice.isAcknowledged {
                Label("Response required", systemImage: "exclamationmark.circle.fill")
                    .font(.callout.weight(.semibold)).foregroundStyle(Theme.missed)
            }
        }
        .padding(.vertical, 8)
    }
}

@MainActor
struct NoticeDetailView: View {
    @Environment(SessionModel.self) private var session
    let notice: Notice
    let acknowledge: () async -> Void
    @State private var confirming = false
    @State private var working = false
    private var zone: String { session.projectZone }

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            Text(notice.title).font(.largeTitle.bold())
            Text("\(StatusStyle.humanize(notice.type)) · issued \(ISODate.display(notice.issuedAt, zone: zone)) by \(notice.issuedByRole)")
                .foregroundStyle(Theme.textSecondary)
            ScrollView { Text(notice.body).font(.title3).frame(maxWidth: .infinity, alignment: .leading) }
                .frame(maxHeight: 500)
            if let due = notice.responseDueAt {
                Label("Response due \(ISODate.display(due, zone: zone))", systemImage: "clock")
                    .foregroundStyle(Theme.late)
            }
            if let ack = notice.acknowledgedAt {
                Label("Acknowledged \(ISODate.display(ack, zone: zone))", systemImage: "checkmark.circle")
                    .foregroundStyle(Theme.timely)
            } else {
                Button { confirming = true } label: {
                    if working { ProgressView() } else { Label("Acknowledge receipt", systemImage: "checkmark.circle") }
                }
                .disabled(working)
                .confirmationDialog("Acknowledge this notice?", isPresented: $confirming, titleVisibility: .visible) {
                    Button("Acknowledge") {
                        working = true
                        Task { await acknowledge(); working = false }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This records, with a server timestamp, that you received and read it. It does not dispute or resolve it.")
                }
            }
        }
        .padding(Theme.screenPadding)
        .frame(maxWidth: 1500, alignment: .leading)
    }
}
