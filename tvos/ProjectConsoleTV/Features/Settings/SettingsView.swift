import SwiftUI

@MainActor
struct SettingsView: View {
    @Environment(SessionModel.self) private var session
    let identity: Identity?

    @State private var server = AppSettings.serverURLString
    @State private var slug = AppSettings.publicSlug
    @State private var saved = false
    @State private var confirmSignOut = false

    var body: some View {
        Form {
            Section("Server") {
                TextField("Server URL", text: $server)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                TextField("Public project slug (blank = server default)", text: $slug)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button("Save", systemImage: "square.and.arrow.down") { save() }
                if saved { Label("Saved", systemImage: "checkmark").foregroundStyle(Theme.timely) }
                if URL(string: server)?.scheme == "http", !(server.contains("localhost") || server.contains("127.0.0.1")) {
                    Label("Plain HTTP is for local development only. Use HTTPS in production.", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Theme.late)
                }
            }

            Section("Remote controls") {
                LabeledContent("Swipe / arrows", value: "Move focus · left/right switches tabs")
                LabeledContent("Click (Select)", value: "Open card, notice or day")
                LabeledContent("Play/Pause", value: "Refresh the current screen")
                LabeledContent("Back / Menu", value: "Close detail · return to tab bar")
            }

            if let identity {
                Section("Account") {
                    LabeledContent("Signed in as", value: identity.displayName)
                    LabeledContent("Role", value: identity.role)
                    Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        confirmSignOut = true
                    }
                    .confirmationDialog("Sign out of Project Console on this Apple TV?", isPresented: $confirmSignOut) {
                        Button("Sign Out", role: .destructive) { session.signOut() }
                        Button("Cancel", role: .cancel) {}
                    }
                }
            }

            Section("About") {
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                Text("The Apple TV app is a viewing and acknowledgement surface. Evidence capture and submission happen in the phone app; the server's received time is the only one that counts.")
                    .font(.callout).foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(.horizontal, Theme.screenPadding)
    }

    private func save() {
        AppSettings.serverURLString = server.trimmingCharacters(in: .whitespacesAndNewlines)
        AppSettings.publicSlug = slug.trimmingCharacters(in: .whitespacesAndNewlines)
        saved = true
        session.requestRefresh()
    }
}
