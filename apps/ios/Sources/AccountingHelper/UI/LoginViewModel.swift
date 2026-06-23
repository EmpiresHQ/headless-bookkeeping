import Foundation

@MainActor
@Observable
public final class LoginViewModel {
    private let auth: AuthService
    private let deviceName: String
    public var isAuthenticated = false
    public var errorMessage: String?
    /// Invoked on the main actor right after a successful enrollment so the
    /// composition root can flip the app to its authenticated state immediately
    /// (without waiting for the next foreground / relaunch).
    public var onAuthenticated: (() -> Void)?

    public init(auth: AuthService, deviceName: String) {
        self.auth = auth; self.deviceName = deviceName
    }

    public func handleScan(_ raw: String) async {
        errorMessage = nil
        do {
            let payload = try QRPayload.parse(raw)
            _ = try await auth.enroll(payload: payload, deviceName: deviceName)
            isAuthenticated = true
            onAuthenticated?()
        } catch {
            errorMessage = "\(error)"
        }
    }
}
