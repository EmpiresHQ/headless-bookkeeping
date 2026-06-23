import Testing
import Foundation
@testable import AccountingHelper

@Suite struct PhotoSourceContractTests {
    @Test func fakeReturnsSeededAssetsAndData() async throws {
        let source = FakePhotoSource(assets: [
            PhotoAsset(localId: "A1", capturedAt: Date(timeIntervalSince1970: 10)),
        ], data: ["A1": PhotoData(bytes: Data([0xFF]), utiType: "public.heic", filename: "A1.HEIC")])

        let assets = await source.enumerateImages()
        #expect(assets.map(\.localId) == ["A1"])
        let d = try await source.loadOriginal(localId: "A1")
        #expect(d.utiType == "public.heic")
        #expect(d.bytes == Data([0xFF]))
    }
}
