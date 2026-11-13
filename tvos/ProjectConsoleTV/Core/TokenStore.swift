import Foundation
import Security

/// Bearer token + identity persisted in the Keychain (never UserDefaults).
enum TokenStore {
    private static let service = "com.michealrayberry.console.tv"
    private static let account = "session"

    struct Stored: Codable { let token: String; let identity: Identity }

    static func save(_ value: Stored) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        clear()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func load() -> Stored? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// Non-secret settings: which server to talk to and which public project slug.
enum AppSettings {
    static let defaultServer = "http://localhost:3000"
    private static let serverKey = "serverURL"
    private static let slugKey = "publicSlug"

    static var serverURLString: String {
        get { UserDefaults.standard.string(forKey: serverKey) ?? defaultServer }
        set { UserDefaults.standard.set(newValue, forKey: serverKey) }
    }

    static var serverURL: URL? {
        let raw = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw), let scheme = url.scheme, ["http", "https"].contains(scheme),
              url.host != nil else { return nil }
        return url
    }

    /// Empty = let the server pick its default project.
    static var publicSlug: String {
        get { UserDefaults.standard.string(forKey: slugKey) ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: slugKey) }
    }
}
