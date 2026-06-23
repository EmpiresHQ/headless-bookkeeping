import Testing
import Foundation
import CoreGraphics
@testable import AccountingHelper

// SIMULATOR-ONLY and skipped unless the model package exists in Models/.
// MobileCLIPRunner is #if os(iOS); this suite is excluded from the macOS host run.
#if os(iOS)
@Suite struct MobileCLIPRunnerTests {
    @Test func embeddingHasExpectedDimension() async throws {
        let modelURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Models/MobileCLIP-S0-image.mlpackage")
        try #require(FileManager.default.fileExists(atPath: modelURL.path),
                     "model not downloaded; run Scripts/fetch-model.sh")
        let runner = try MobileCLIPRunner(modelURL: modelURL)
        let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let img = ctx.makeImage()!
        let emb = try await runner.imageEmbedding(img)
        #expect(emb.count == 512)
    }
}
#endif
