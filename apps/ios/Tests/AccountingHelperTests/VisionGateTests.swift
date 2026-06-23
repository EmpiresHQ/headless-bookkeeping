import Testing
import CoreGraphics
@testable import AccountingHelper

// SIMULATOR-ONLY: VNDetectDocumentSegmentationRequest needs the Vision runtime
// and VisionGate is #if os(iOS). Excluded from the macOS host run; runs in CI on
// an iOS simulator destination.
#if os(iOS)
@Suite struct VisionGateTests {
    @Test func blankImageIsNotADocument() async throws {
        // A 32x32 solid-grey image has no document rectangle.
        let ctx = CGContext(data: nil, width: 32, height: 32, bitsPerComponent: 8,
                            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        let img = ctx.makeImage()!
        let gate = VisionGate()
        let result = await gate.looksLikeDocument(img)
        #expect(result == false)
    }
}
#endif
