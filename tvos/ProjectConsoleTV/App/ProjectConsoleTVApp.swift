import SwiftUI

@main
struct ProjectConsoleTVApp: App {
    @State private var session = SessionModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            // Re-anchor to server time whenever the app comes back to the
            // foreground — the TV may have slept for hours.
            if phase == .active { session.foregrounded() }
        }
    }
}

/// Routes between sign-in and the signed-in tab shell. The public board is
/// reachable from both, because it needs no credentials.
@MainActor
struct RootView: View {
    @Environment(SessionModel.self) private var session

    var body: some View {
        switch session.state {
        case .restoring:
            ProgressView("Restoring session…")
        case .signedOut:
            SignedOutView()
        case .signedIn(let identity):
            MainTabView(identity: identity)
        }
    }
}

/// Top tab bar — the native tvOS control surface. Swipe/arrow left-right on the
/// Siri Remote moves between tabs; swipe down enters the tab's content.
@MainActor
struct MainTabView: View {
    let identity: Identity

    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Today", systemImage: "calendar") }
            HistoryView()
                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
            NoticesView()
                .tabItem { Label("Notices", systemImage: "exclamationmark.bubble") }
            PublicBoardView()
                .tabItem { Label("Public Board", systemImage: "chart.line.downtrend.xyaxis") }
            SettingsView(identity: identity)
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}
