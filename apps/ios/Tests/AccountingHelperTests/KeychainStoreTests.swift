import Testing
import Foundation
@testable import AccountingHelper

// SIMULATOR-ONLY: exercises the real Security framework keychain. The
// SystemKeychainStore impl is #if os(iOS), so this suite only compiles/runs on
// an iOS destination (CI xcodebuild). It is excluded from the macOS host run.
#if os(iOS)
@Suite struct KeychainStoreTests {
    @Test func saveReadDeleteRoundTrip() throws {
        let store = SystemKeychainStore(service: "test.accountinghelper.\(UUID().uuidString)")
        #expect(try store.read() == nil)
        try store.save(token: "tok-1")
        #expect(try store.read() == "tok-1")
        try store.save(token: "tok-2") // overwrite
        #expect(try store.read() == "tok-2")
        try store.delete()
        #expect(try store.read() == nil)
    }
}
#endif
