import Foundation
import Observation

/// App-wide session: auth state, the API client, and the server clock anchor.
@MainActor
@Observable
final class SessionModel {
    enum State: Equatable {
        case restoring
        case signedOut
        case signedIn(Identity)
    }

    private(set) var state: State = .restoring
    private(set) var clock: ServerClock?
    /// Project IANA zone, as reported by the server on the last Today sync.
    /// Every displayed time uses this zone, never the Apple TV's own.
    private(set) var projectZone = "America/New_York"
    /// Bumped whenever screens should reload (foregrounding, Play/Pause refresh).
    private(set) var refreshToken = 0

    private var token: String?

    init() {
        if let stored = TokenStore.load(), stored.identity.role == "PARTICIPANT" {
            token = stored.token
            state = .signedIn(stored.identity)
        } else {
            state = .signedOut
        }
    }

    /// Authenticated client for participant calls.
    func client() throws -> APIClient {
        guard let base = AppSettings.serverURL else { throw APIError.invalidServerURL }
        return APIClient(baseURL: base, token: token)
    }

    /// Unauthenticated client for the public board.
    func publicClient() throws -> APIClient {
        guard let base = AppSettings.serverURL else { throw APIError.invalidServerURL }
        return APIClient(baseURL: base, token: nil)
    }

    func signIn(email: String, password: String) async throws {
        let response = try await publicClient().login(email: email, password: password)
        // The TV app is a participant surface. AP administration stays on the
        // portal, where it has MFA, audit context and a full keyboard.
        guard response.user.role == "PARTICIPANT" else {
            throw APIError.server(status: 403, message: "This app is for the participant account. Use the AP portal for administration.")
        }
        token = response.token
        TokenStore.save(.init(token: response.token, identity: response.user))
        state = .signedIn(response.user)
    }

    func signOut() {
        token = nil
        clock = nil
        TokenStore.clear()
        state = .signedOut
    }

    /// Re-anchor the countdown to the server's clock.
    func sync(serverTime: String, timeZone: String) {
        if let date = ISODate.parse(serverTime) { clock = ServerClock(serverTime: date) }
        if TimeZone(identifier: timeZone) != nil { projectZone = timeZone }
    }

    func requestRefresh() { refreshToken &+= 1 }

    func foregrounded() { requestRefresh() }

    /// Central handling so any screen that sees a 401 drops back to sign-in.
    func handle(_ error: Error) -> String {
        if let api = error as? APIError, api == .unauthorized { signOut() }
        return error.localizedDescription
    }
}
