import Testing
import Foundation
@testable import AccountingHelper

@Suite struct ModelManifestTests {
    @Test func bundledManifestHasURLAndChecksum() throws {
        let m = try ModelManifest.bundled()
        #expect(!m.version.isEmpty)
        #expect(m.url.scheme == "https")
        #expect(m.sha256.count == 64) // hex sha-256
    }
}
