import Testing
import Foundation
@testable import AccountingHelper

@Suite struct AuthServiceTests {
    @Test func enrollStoresSessionToken() async throws {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 201,
            data: #"{"accessToken":"sess-xyz"}"#.data(using: .utf8)!))]
        let keychain = FakeKeychain()
        let svc = AuthService(apiFor: { _ in api }, keychain: keychain)
        let payload = QRPayload(api: URL(string: "https://api.test")!, enroll: "enr-1")

        let token = try await svc.enroll(payload: payload, deviceName: "iPhone QA")

        #expect(token == "sess-xyz")
        #expect(try keychain.read() == "sess-xyz")
        let sent = api.sent.first!
        #expect(sent.method == "POST")
        #expect(sent.path == "/api/mobile/sessions")
        #expect(sent.bearer == "enr-1")
        #expect(String(data: sent.body!, encoding: .utf8)!.contains("iPhone QA"))
    }

    @Test func enrollThrowsOnNon2xx() async {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 401, data: Data()))]
        let keychain = FakeKeychain()
        let svc = AuthService(apiFor: { _ in api }, keychain: keychain)
        let payload = QRPayload(api: URL(string: "https://api.test")!, enroll: "bad")
        await #expect(throws: AuthError.exchangeFailed(401)) {
            _ = try await svc.enroll(payload: payload, deviceName: "x")
        }
        #expect((try? keychain.read()) == nil)
    }

    @Test func logoutRevokesThenClearsKeychain() async throws {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 204, data: Data()))]
        let keychain = FakeKeychain()
        try keychain.save(token: "sess-old")
        let svc = AuthService(apiFor: { _ in api }, keychain: keychain)

        await svc.logout(baseURL: URL(string: "https://api.test")!)

        #expect(api.sent.first?.path == "/api/mobile/sessions/revoke")
        #expect(api.sent.first?.bearer == "sess-old")
        #expect(try keychain.read() == nil)
    }

    @Test func logoutClearsKeychainEvenIfRevokeFails() async throws {
        let api = FakeAPIClient()
        api.responses = [.failure(URLError(.notConnectedToInternet))]
        let keychain = FakeKeychain()
        try keychain.save(token: "sess-old")
        let svc = AuthService(apiFor: { _ in api }, keychain: keychain)

        await svc.logout(baseURL: URL(string: "https://api.test")!)

        #expect(try keychain.read() == nil)
    }
}
