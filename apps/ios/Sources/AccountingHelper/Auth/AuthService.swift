import Foundation

public enum AuthError: Error, Equatable {
    case exchangeFailed(Int)
    case noStoredSession
}

public final class AuthService: Sendable {
    private let apiFor: @Sendable (URL) -> APIClient
    private let keychain: KeychainStore
    private static let baseURLKey = "apiBaseURL"

    public init(apiFor: @escaping @Sendable (URL) -> APIClient, keychain: KeychainStore) {
        self.apiFor = apiFor
        self.keychain = keychain
    }

    public func enroll(payload: QRPayload, deviceName: String) async throws -> String {
        let body = try JSONSerialization.data(withJSONObject: ["deviceName": deviceName])
        let resp = try await apiFor(payload.api).send(APIRequest(
            method: "POST", path: "/api/mobile/sessions",
            body: body, contentType: "application/json", bearer: payload.enroll))
        guard (200...299).contains(resp.status) else {
            throw AuthError.exchangeFailed(resp.status)
        }
        let parsed = try JSONSerialization.jsonObject(with: resp.data) as? [String: Any]
        guard let token = parsed?["accessToken"] as? String else {
            throw AuthError.exchangeFailed(resp.status)
        }
        try keychain.save(token: token)
        // Persist the API base URL so later uploads / logout reach the same server.
        UserDefaults.standard.set(payload.api.absoluteString, forKey: Self.baseURLKey)
        return token
    }

    public func currentToken() throws -> String? {
        try keychain.read()
    }

    /// The API base URL captured at enrollment (nil before enrolling).
    public func apiBaseURL() -> URL? {
        guard let s = UserDefaults.standard.string(forKey: Self.baseURLKey) else { return nil }
        return URL(string: s)
    }

    public func logout(baseURL: URL) async {
        if let token = try? keychain.read() {
            _ = try? await apiFor(baseURL).send(APIRequest(
                method: "POST", path: "/api/mobile/sessions/revoke", bearer: token))
        }
        try? keychain.delete()
        UserDefaults.standard.removeObject(forKey: Self.baseURLKey)
    }
}
