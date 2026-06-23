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
    // Optional VLM precision filter run AFTER the cheap gate passes. nil = current
    // behavior (gate/model decide). When present it can veto a gate-passed image that
    // is text-heavy but not a document (weather/chat/web screenshots).
    private let secondPass: SecondPassClassifier?
    private let uploader: DocumentUploader
    private let store: ScanStateStore
    private let settings: AppSettings
    private let decode: @Sendable (PhotoData) -> CGImage?

    public init(photos: PhotoSource, gate: ImageGate, model: ModelRunner?, labels: LabelSet?,
                secondPass: SecondPassClassifier? = nil,
                uploader: DocumentUploader, store: ScanStateStore, settings: AppSettings,
                decode: @escaping @Sendable (PhotoData) -> CGImage?) {
        self.photos = photos; self.gate = gate; self.model = model; self.labels = labels
        self.secondPass = secondPass
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
            // Stop promptly when the scan is cancelled (Stop sync / logout), instead
            // of grinding through the rest of the batch.
            if Task.isCancelled { break }
            // Skip terminally-handled assets; previously-failed ones are retried.
            if let st = (try? store.status(of: asset.localId)) ?? nil, st != .failed {
                summary.skipped += 1; continue
            }
            // Skip screenshots unless opted in (not recorded, so flipping the
            // setting on later reconsiders them).
            if asset.isScreenshot && !settings.includeScreenshots {
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

            // Optional VLM second pass: only a definitive `false` vetoes. `nil`
            // (model unavailable / undecided) is treated as a PASS to preserve recall,
            // so an unbundled/loading model never silently drops real documents.
            // The verdict is surfaced in the log label so it's visible whether (and
            // how) the VLM decided.
            var vlmVerdict: Bool?
            if let secondPass {
                vlmVerdict = await secondPass.isAccountingDocument(image)
                if vlmVerdict == false {
                    try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .ignored,
                                               topLabel: "vlm:not_document", score: 0, at: Date()))
                    summary.ignored += 1; continue
                }
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

            // Label reflects the VLM verdict when the second pass ran.
            let recordLabel: String
            switch vlmVerdict {
            case .some(true): recordLabel = "vlm:document"
            case .none where secondPass != nil: recordLabel = "vlm:undecided"
            default: recordLabel = result.topLabel
            }

            if result.decision == .upload && settings.autoUpload {
                let input = UploadInput(assetLocalId: asset.localId, capturedAt: asset.capturedAt,
                                        data: data, precheck: result)
                do {
                    _ = try await uploader.upload(input)
                    try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .uploaded,
                                               topLabel: recordLabel, score: result.topScore, at: Date()))
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
                                           topLabel: recordLabel, score: result.topScore, at: Date()))
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
