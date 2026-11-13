import SwiftUI

/// Gate status shown at the top of Today. In a locked state it states exactly
/// what's owed. There's no button to unlock: clearing comes only from the
/// server, after the evidence arrives.
@MainActor
struct GateCard: View {
    @Environment(GateController.self) private var gate
    @Environment(SessionModel.self) private var session

    var body: some View {
        if gate.mode != .off, let verdict = gate.verdict {
            VStack(alignment: .leading, spacing: 16) {
                switch verdict {
                case .cleared:
                    Label("TV CLEARED: today's mandatory evidence is in", systemImage: "lock.open.fill")
                        .font(.title2.bold()).foregroundStyle(Theme.timely)
                    if gate.mode == .manual && gate.singleAppModeActive {
                        Text("AP: Single App Mode can now be ended in Apple Configurator.")
                            .foregroundStyle(Theme.textSecondary)
                    }
                case .notYetLocking(let start):
                    Label("TV locks at \(ISODate.time(start, zone: session.projectZone)) unless today's evidence is in",
                          systemImage: "lock.badge.clock")
                        .font(.title2.bold()).foregroundStyle(Theme.grace)
                case .locked(let owed, let failed):
                    Label("TV LOCKED until today's mandatory evidence is submitted", systemImage: "lock.fill")
                        .font(.title2.bold()).foregroundStyle(Theme.missed)
                    if !owed.isEmpty {
                        Text("Owed: " + owed.joined(separator: " · ")).font(.title3)
                    }
                    if !failed.isEmpty {
                        Text("Missed or deficient: " + failed.joined(separator: " · ") +
                             ". The TV stays locked for the rest of today.")
                            .font(.title3).foregroundStyle(Theme.missed)
                    }
                }
                if gate.mode == .autonomous, let status = gate.autonomousStatus {
                    Text(status).font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            .padding(32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(borderColor(verdict), lineWidth: 3))
            .accessibilityElement(children: .combine)
        }
    }

    private func borderColor(_ v: GateVerdict) -> Color {
        switch v {
        case .cleared: Theme.timely
        case .notYetLocking: Theme.grace
        case .locked: Theme.missed
        }
    }
}
