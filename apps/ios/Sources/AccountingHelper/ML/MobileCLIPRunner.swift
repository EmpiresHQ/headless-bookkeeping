#if os(iOS)
import CoreML
import CoreGraphics
import CoreVideo

public final class MobileCLIPRunner: ModelRunner {
    // `MLModel` is not `Sendable`, but it is immutable after load and Core ML's
    // `prediction` is safe to call concurrently, so this runner can satisfy the
    // `Sendable` requirement of `ModelRunner`. `nonisolated(unsafe)` opts this one
    // stored property out of the compiler's Sendable check (asserting that safety)
    // rather than dropping the whole type's checking.
    private nonisolated(unsafe) let model: MLModel

    public init(modelURL: URL) throws {
        let compiled = try MLModel.compileModel(at: modelURL)
        self.model = try MLModel(contentsOf: compiled)
    }

    public func imageEmbedding(_ image: CGImage) async throws -> [Float] {
        // MobileCLIP-S0 image encoder input: 256x256 RGB (per model card).
        let side = 256
        let provider = try imageFeatureProvider(image, side: side)
        let out = try await model.prediction(from: provider)
        guard let name = model.modelDescription.outputDescriptionsByName.keys.first,
              let multi = out.featureValue(for: name)?.multiArrayValue else {
            return []
        }
        return (0..<multi.count).map { Float(truncating: multi[$0]) }
    }

    private func imageFeatureProvider(_ image: CGImage, side: Int) throws -> MLFeatureProvider {
        let inputName = model.modelDescription.inputDescriptionsByName.keys.first ?? "image"
        let buffer = try pixelBuffer(from: image, side: side)
        return try MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(pixelBuffer: buffer)])
    }

    private func pixelBuffer(from image: CGImage, side: Int) throws -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        let attrs = [kCVPixelBufferCGImageCompatibilityKey: true,
                     kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary
        CVPixelBufferCreate(kCFAllocatorDefault, side, side, kCVPixelFormatType_32ARGB, attrs, &pb)
        guard let buffer = pb else { throw NSError(domain: "MobileCLIPRunner", code: 2) }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer),
                            width: side, height: side, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return buffer
    }
}
#endif
