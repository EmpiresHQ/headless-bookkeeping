@testable import AccountingHelper
import Foundation

final class FakeKeychain: KeychainStore, @unchecked Sendable {
    private var stored: String?
    var saveError: Error?
    func save(token: String) throws { if let saveError { throw saveError }; stored = token }
    func read() throws -> String? { stored }
    func delete() throws { stored = nil }
}
