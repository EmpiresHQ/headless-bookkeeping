import Foundation

@MainActor
@Observable
public final class LoginViewModel {
    private let auth: AuthService
    private let deviceName: String
    public var isAuthenticated = false
    public var errorMessage: String?

    public init(auth: AuthService, deviceName: String) {
        self.auth = auth; self.deviceName = deviceName
    }

    public func handleScan(_ raw: String) async {
        errorMessage = nil
        do {
            let payload = try QRPayload.parse(raw)
            _ = try await auth.enroll(payload: payload, deviceName: deviceName)
            isAuthenticated = true
        } catch {
            errorMessage = "\(error)"
        }
    }
}
