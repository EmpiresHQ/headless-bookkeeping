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
    private let minTextCoverage: Double
    private let minDocConfidence: Float

    /// - minTextLines: how many recognized text lines a document must have.
    /// - minTextCoverage: fraction of the image area covered by text. A receipt's
    ///   text fills a large central column; a street scene only has tiny scattered
    ///   signage. Requiring BOTH cuts false positives like a café photo with a
    ///   table placard + distant shop signs.
    public init(minTextLines: Int = 8, minTextCoverage: Double = 0.05,
                minDocConfidence: Float = 0.3) {
        self.minTextLines = minTextLines
        self.minTextCoverage = minTextCoverage
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
                let text = (textRequest.results as? [VNRecognizedTextObservation]) ?? []
                let lines = text.count
                // Normalized bounding boxes → area sum approximates text coverage.
                let coverage = text.reduce(0.0) {
                    $0 + Double($1.boundingBox.width * $1.boundingBox.height)
                }
                let textHeavy = lines >= self.minTextLines && coverage >= self.minTextCoverage
                let hasDocRect = (docRequest.results as? [VNRectangleObservation])?
                    .contains { $0.confidence >= self.minDocConfidence } ?? false
                continuation.resume(returning: textHeavy || hasDocRect)
            } catch {
                continuation.resume(returning: false)
            }
        }
    }
}
#endif
