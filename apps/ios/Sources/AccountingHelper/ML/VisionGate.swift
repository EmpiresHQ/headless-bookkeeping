#if os(iOS)
import Vision
import CoreGraphics

public final class VisionGate: ImageGate {
    private let minConfidence: Float

    public init(minConfidence: Float = 0.5) {
        self.minConfidence = minConfidence
    }

    public func looksLikeDocument(_ image: CGImage) async -> Bool {
        await withCheckedContinuation { continuation in
            let request = VNDetectDocumentSegmentationRequest { req, _ in
                let hit = (req.results as? [VNRectangleObservation])?
                    .contains { $0.confidence >= self.minConfidence } ?? false
                continuation.resume(returning: hit)
            }
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            do { try handler.perform([request]) }
            catch { continuation.resume(returning: false) }
        }
    }
}
#endif
