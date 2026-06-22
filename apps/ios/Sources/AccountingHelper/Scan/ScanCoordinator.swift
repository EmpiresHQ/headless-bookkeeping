import Foundation
import CoreGraphics

public struct ScanSummary: Equatable, Sendable {
    public var examined = 0, uploaded = 0, ignored = 0, skipped = 0, failed = 0
    public init() {}
}

public final class ScanCoordinator {
    private let photos: PhotoSource
    private let gate: ImageGate
    private let model: ModelRunner
    private let labels: LabelSet
    private let uploader: DocumentUploader
    private let store: ScanStateStore
    private let settings: AppSettings
    private let decode: @Sendable (PhotoData) -> CGImage?

    public init(photos: PhotoSource, gate: ImageGate, model: ModelRunner, labels: LabelSet,
                uploader: DocumentUploader, store: ScanStateStore, settings: AppSettings,
                decode: @escaping @Sendable (PhotoData) -> CGImage?) {
        self.photos = photos; self.gate = gate; self.model = model; self.labels = labels
        self.uploader = uploader; self.store = store; self.settings = settings; self.decode = decode
    }

    public func scanOnce() async -> ScanSummary {
        var summary = ScanSummary()
        let assets = await photos.enumerateImages()
        for asset in assets {
            if ((try? store.status(of: asset.localId)) ?? nil) != nil { summary.skipped += 1; continue }
            summary.examined += 1
            guard let data = try? await photos.loadOriginal(localId: asset.localId),
                  let image = decode(data) else { summary.failed += 1; continue }

            if await gate.looksLikeDocument(image) == false {
                try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .ignored,
                                           topLabel: "gate:not_document", score: 0, at: Date()))
                summary.ignored += 1; continue
            }
            guard let emb = try? await model.imageEmbedding(image) else { summary.failed += 1; continue }
            let result = PrecheckDecision.decide(imageEmbedding: emb, labels: labels, threshold: settings.threshold)

            if result.decision == .upload && settings.autoUpload {
                let input = UploadInput(assetLocalId: asset.localId, capturedAt: asset.capturedAt,
                                        data: data, precheck: result)
                do {
                    _ = try await uploader.upload(input)
                    try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .uploaded,
                                               topLabel: result.topLabel, score: result.topScore, at: Date()))
                    summary.uploaded += 1
                } catch {
                    summary.failed += 1 // unrecorded → retried next scan
                }
            } else {
                try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .ignored,
                                           topLabel: result.topLabel, score: result.topScore, at: Date()))
                summary.ignored += 1
            }
        }
        return summary
    }
}
