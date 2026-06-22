#if os(iOS)
import Vision
import CoreGraphics

/// Cheap on-device "is this a financial document?" gate.
///
/// A receipt/invoice/payment slip is characterised by DENSE TEXT — far more than
/// a selfie, a food photo, or a landscape. Earlier this used only
/// `VNDetectDocumentSegmentationRequest`, which looks for a rectangular document
/// lying in a scene; that misses receipts shot full-frame and screenshots of
/// receipts (no rectangle to find). So the primary signal is now recognized-text
/// density, with document-rectangle detection kept as a secondary OR.
public final class VisionGate: ImageGate {
    private let minTextLines: Int
    private let minDocConfidence: Float

    public init(minTextLines: Int = 5, minDocConfidence: Float = 0.3) {
        self.minTextLines = minTextLines
        self.minDocConfidence = minDocConfidence
    }

    public func looksLikeDocument(_ image: CGImage) async -> Bool {
        await withCheckedContinuation { continuation in
            let textRequest = VNRecognizeTextRequest()
            textRequest.recognitionLevel = .fast
            textRequest.usesLanguageCorrection = false

            let docRequest = VNDetectDocumentSegmentationRequest()

            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            do {
                try handler.perform([textRequest, docRequest])
                let lines = (textRequest.results as? [VNRecognizedTextObservation])?.count ?? 0
                let hasDocRect = (docRequest.results as? [VNRectangleObservation])?
                    .contains { $0.confidence >= self.minDocConfidence } ?? false
                continuation.resume(returning: lines >= self.minTextLines || hasDocRect)
            } catch {
                continuation.resume(returning: false)
            }
        }
    }
}
#endif
