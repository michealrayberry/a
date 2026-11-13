import SwiftUI

/// Signed-out shell: sign in, or view the public board / settings without an account.
@MainActor
struct SignedOutView: View {
    var body: some View {
        TabView {
            LoginView()
                .tabItem { Label("Sign In", systemImage: "person.badge.key") }
            PublicBoardView()
                .tabItem { Label("Public Board", systemImage: "chart.line.downtrend.xyaxis") }
            SettingsView(identity: nil)
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

@MainActor
struct LoginView: View {
    @Environment(SessionModel.self) private var session
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var working = false
    @FocusState private var focus: Field?

    private enum Field { case email, password, submit }

    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            Text("Project Console").font(.largeTitle.bold())
            Text("Participant sign-in. Selecting a field opens the on-screen keyboard; you can also type from a nearby iPhone.")
                .font(.headline)
                .foregroundStyle(Theme.textSecondary)

            TextField("Email", text: $email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .focused($focus, equals: .email)
                .onSubmit { focus = .password }

            SecureField("Password", text: $password)
                .textContentType(.password)
                .focused($focus, equals: .password)
                .onSubmit { submit() }

            HStack(spacing: 24) {
                Button {
                    submit()
                } label: {
                    if working { ProgressView() } else { Label("Sign In", systemImage: "arrow.right.circle.fill") }
                }
                .disabled(working || email.isEmpty || password.isEmpty)
                .focused($focus, equals: .submit)

                Text("Server: \(AppSettings.serverURLString)")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.missed)
                    .font(.headline)
            }
        }
        .frame(maxWidth: 1200, alignment: .leading)
        .padding(Theme.screenPadding)
        .onAppear { focus = .email }
    }

    private func submit() {
        guard !working else { return }
        working = true
        error = nil
        Task {
            defer { working = false }
            do { try await session.signIn(email: email.trimmingCharacters(in: .whitespaces), password: password) }
            catch { self.error = error.localizedDescription; password = "" }
        }
    }
}
