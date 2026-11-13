import Foundation

enum APIError: LocalizedError, Equatable {
    case invalidServerURL
    case unauthorized
    case server(status: Int, message: String)
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: "The server address in Settings is not a valid URL."
        case .unauthorized: "Your session expired. Sign in again."
        case .server(let status, let message): "Server error \(status): \(message)"
        case .transport(let message): "Could not reach the server. \(message)"
        case .decoding(let message): "Unexpected response from the server. \(message)"
        }
    }
}

/// Thin async client over the Project Console REST API. Holds no state beyond
/// the base URL and bearer token it is given.
struct APIClient: Sendable {
    let baseURL: URL
    let token: String?
    var session: URLSession = .shared

    // MARK: Auth
    func login(email: String, password: String) async throws -> LoginResponse {
        try await send("POST", "/auth/login", body: ["email": email, "password": password])
    }

    // MARK: Participant
    func today() async throws -> TodayResponse { try await send("GET", "/participant/today") }
    func history() async throws -> [ProjectDay] { try await send("GET", "/participant/history") }
    func day(id: String) async throws -> DayDetailResponse {
        try await send("GET", "/participant/project-days/\(id)")
    }
    func notices() async throws -> [Notice] { try await send("GET", "/participant/notices") }
    func acknowledgeNotice(id: String) async throws {
        let _: OK = try await send("POST", "/participant/notices/\(id)/acknowledge")
    }

    // MARK: Public
    func publicStatus(slug: String?) async throws -> PublicStatus {
        try await send("GET", "/public/status", query: slugQuery(slug))
    }
    func publicDays(slug: String?) async throws -> [PublicDay] {
        try await send("GET", "/public/project-days", query: slugQuery(slug))
    }
    func publicWeights(slug: String?) async throws -> [PublicWeight] {
        try await send("GET", "/public/weights", query: slugQuery(slug))
    }

    // MARK: Plumbing
    private struct OK: Decodable {}
    private struct ErrorBody: Decodable { let error: String }

    private func slugQuery(_ slug: String?) -> [URLQueryItem] {
        guard let slug, !slug.isEmpty else { return [] }
        return [URLQueryItem(name: "slug", value: slug)]
    }

    private func send<T: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: [String: String]? = nil
    ) async throws -> T {
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        else { throw APIError.invalidServerURL }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidServerURL }

        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport("No HTTP response.") }

        switch http.statusCode {
        case 200..<300:
            do { return try JSONDecoder().decode(T.self, from: data) }
            catch { throw APIError.decoding(String(describing: error)) }
        case 401:
            throw APIError.unauthorized
        default:
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data).error)
                ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw APIError.server(status: http.statusCode, message: message)
        }
    }
}
