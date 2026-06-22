import Foundation
import CoreGraphics

public struct ScanSummary: Equatable, Sendable {
    public var examined = 0, uploaded = 0, ignored = 0, skipped = 0, failed = 0
    public init() {}
}

public final class ScanCoordinator {
    private let photos: PhotoSource
    private let gate: ImageGate
    // Optional: when no on-device model is bundled, classification falls back to
    // the Vision gate alone (gate-passed → upload candidate).
    private let model: ModelRunner?
    private let labels: LabelSet?
    private let uploader: DocumentUploader
    private let store: ScanStateStore
    private let settings: AppSettings
    private let decode: @Sendable (PhotoData) -> CGImage?

    public init(photos: PhotoSource, gate: ImageGate, model: ModelRunner?, labels: LabelSet?,
                uploader: DocumentUploader, store: ScanStateStore, settings: AppSettings,
                decode: @escaping @Sendable (PhotoData) -> CGImage?) {
        self.photos = photos; self.gate = gate; self.model = model; self.labels = labels
        self.uploader = uploader; self.store = store; self.settings = settings; self.decode = decode
    }

    public func scanOnce() async -> ScanSummary {
        var summary = ScanSummary()
        // Newest first, so a bounded run processes recent photos rather than
        // sweeping from the oldest. The local cursor (store.status) skips
        // already-handled assets, so successive scans walk back in batches.
        let assets = (await photos.enumerateImages()).sorted { $0.capturedAt > $1.capturedAt }
        var processed = 0
        for asset in assets {
            // Skip terminally-handled assets; previously-failed ones are retried.
            if let st = (try? store.status(of: asset.localId)) ?? nil, st != .failed {
                summary.skipped += 1; continue
            }
            // Cap NEW work per scan (0 = unlimited) to avoid uploading the whole
            // library in one run.
            if settings.maxPerScan > 0 && processed >= settings.maxPerScan { break }
            processed += 1
            summary.examined += 1
            guard let data = try? await photos.loadOriginal(localId: asset.localId),
                  let image = decode(data) else { summary.failed += 1; continue }

            if await gate.looksLikeDocument(image) == false {
                try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .ignored,
                                           topLabel: "gate:not_document", score: 0, at: Date()))
                summary.ignored += 1; continue
            }
            let result: PrecheckResult
            if let model, let labels {
                guard let emb = try? await model.imageEmbedding(image) else { summary.failed += 1; continue }
                result = PrecheckDecision.decide(imageEmbedding: emb, labels: labels, threshold: settings.threshold)
            } else {
                // Gate-only fallback: no on-device model bundled, so the Vision
                // document gate (already passed above) IS the decision.
                result = PrecheckResult(decision: .upload, topLabel: "gate:document",
                                        topScore: 1.0, scores: [])
            }

            if result.decision == .upload && settings.autoUpload {
                let input = UploadInput(assetLocalId: asset.localId, capturedAt: asset.capturedAt,
                                        data: data, precheck: result)
                do {
                    _ = try await uploader.upload(input)
                    try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .uploaded,
                                               topLabel: result.topLabel, score: result.topScore, at: Date()))
                    summary.uploaded += 1
                } catch {
                    // Record the failure (visible in the log) but keep it eligible
                    // for retry on the next scan (the skip check exempts .failed).
                    try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .failed,
                                               topLabel: "upload failed: \(Self.shortError(error))",
                                               score: result.topScore, at: Date()))
                    summary.failed += 1
                }
            } else {
                try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .ignored,
                                           topLabel: result.topLabel, score: result.topScore, at: Date()))
                summary.ignored += 1
            }
        }
        return summary
    }

    /// Short, human-readable reason for a failed upload, for the scan log.
    static func shortError(_ error: Error) -> String {
        switch error {
        case UploadError.unauthorized: return "401 unauthorized"
        case UploadError.server(let code): return "HTTP \(code)"
        default:
            let ns = error as NSError
            return "\(ns.domain) \(ns.code)"
        }
    }
}
