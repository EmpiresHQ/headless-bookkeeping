import Testing
import Foundation
import CoreGraphics
@testable import AccountingHelper

@Suite struct ScanCoordinatorTests {
    private func oneByOne() -> CGImage {
        let ctx = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        return ctx.makeImage()!
    }

    private func labels() -> LabelSet {
        LabelSet(labels: [
            Label(name: "receipt", prompt: "", isFinancial: true, embedding: [1, 0]),
            Label(name: "selfie", prompt: "", isFinancial: false, embedding: [0, 1]),
        ])
    }

    private func make(uploadResult: Result<Bool, Error>, modelEmbedding: [Float], gatePasses: Bool,
                      assets: [PhotoAsset], settings: AppSettings)
        -> (ScanCoordinator, FakeScanStateStore, FakeAPIClient) {
        let api = FakeAPIClient()
        switch uploadResult {
        case .success: api.responses = [.success(APIResponse(status: 201, data: Data()))]
        case .failure(let e): api.responses = [.failure(e)]
        }
        let store = FakeScanStateStore()
        let model = FakeModelRunner(); model.embedding = modelEmbedding
        let gate = FakeGate(); gate.passes = gatePasses
        let source = FakePhotoSource(
            assets: assets,
            data: Dictionary(uniqueKeysWithValues: assets.map {
                ($0.localId, PhotoData(bytes: Data([0x1]), utiType: "public.heic", filename: "\($0.localId).HEIC")) }))
        let uploader = DocumentUploader(client: api, tokenProvider: { "sess" })
        let oneByOne = self.oneByOne()
        let coord = ScanCoordinator(photos: source, gate: gate, model: model, labels: labels(),
                                    uploader: uploader, store: store, settings: settings,
                                    decode: { _ in oneByOne })
        return (coord, store, api)
    }

    @Test func uploadsFinancialAsset() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, api) = make(uploadResult: .success(true), modelEmbedding: [1, 0],
                                       gatePasses: true,
                                       assets: [PhotoAsset(localId: "A1", capturedAt: Date())], settings: s)
        let summary = await coord.scanOnce()
        #expect(summary.uploaded == 1)
        #expect((try? store.status(of: "A1")) == .uploaded)
        #expect(api.sent.count == 1)
    }

    @Test func ignoresNonFinancialAndRecordsIgnored() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, _) = make(uploadResult: .success(true), modelEmbedding: [0, 1],
                                     gatePasses: true,
                                     assets: [PhotoAsset(localId: "A2", capturedAt: Date())], settings: s)
        let summary = await coord.scanOnce()
        #expect(summary.ignored == 1)
        #expect((try? store.status(of: "A2")) == .ignored)
    }

    @Test func gateFailSkipsModelAndRecordsIgnored() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, _) = make(uploadResult: .success(true), modelEmbedding: [1, 0],
                                     gatePasses: false,
                                     assets: [PhotoAsset(localId: "A3", capturedAt: Date())], settings: s)
        let summary = await coord.scanOnce()
        #expect(summary.ignored == 1)
        #expect((try? store.status(of: "A3")) == .ignored)
    }

    @Test func failedUploadLeavesAssetUnrecordedForRetry() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, _) = make(uploadResult: .failure(UploadError.server(500)),
                                     modelEmbedding: [1, 0], gatePasses: true,
                                     assets: [PhotoAsset(localId: "A4", capturedAt: Date())], settings: s)
        let summary = await coord.scanOnce()
        #expect(summary.failed == 1)
        #expect((try? store.status(of: "A4")) == nil) // retried next scan
    }

    @Test func alreadyHandledAssetIsSkipped() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, api) = make(uploadResult: .success(true), modelEmbedding: [1, 0],
                                       gatePasses: true,
                                       assets: [PhotoAsset(localId: "A5", capturedAt: Date())], settings: s)
        try? store.record(LogEntry(assetLocalId: "A5", outcome: .uploaded, topLabel: "receipt", score: 0.9, at: Date()))
        let summary = await coord.scanOnce()
        #expect(summary.skipped == 1)
        #expect(api.sent.count == 0)
    }
}
