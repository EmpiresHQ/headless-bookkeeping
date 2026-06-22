import Testing
import Foundation
@testable import AccountingHelper

@Suite struct DocumentUploaderTests {
    private func input() -> UploadInput {
        UploadInput(
            assetLocalId: "A1",
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            data: PhotoData(bytes: Data([0x01]), utiType: "public.heic", filename: "A1.HEIC"),
            precheck: PrecheckResult(decision: .upload, topLabel: "receipt", topScore: 0.9,
                                     scores: [LabelScore(name: "receipt", score: 0.9)]))
    }

    @Test func postsMultipartWithAllFields() async throws {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 201, data: Data()))]
        let uploader = DocumentUploader(client: api, tokenProvider: { "sess-1" })

        let ok = try await uploader.upload(input())

        #expect(ok)
        let req = api.sent.first!
        #expect(req.method == "POST")
        #expect(req.path == "/api/documents")
        #expect(req.bearer == "sess-1")
        let body = String(data: req.body!, encoding: .isoLatin1)!
        #expect(body.contains("name=\"channel\""))
        #expect(body.contains("ios_photo_library"))
        #expect(body.contains("name=\"assetLocalId\""))
        #expect(body.contains("A1"))
        #expect(body.contains("name=\"capturedAt\""))
        #expect(body.contains("2023-11-14")) // ISO-8601 date portion
        #expect(body.contains("name=\"precheck\""))
        #expect(body.contains("\"decision\":\"upload\""))
        #expect(body.contains("filename=\"A1.HEIC\""))
    }

    @Test func throwsUnauthorizedOn401() async {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 401, data: Data()))]
        let uploader = DocumentUploader(client: api, tokenProvider: { "sess-1" })
        await #expect(throws: UploadError.unauthorized) {
            _ = try await uploader.upload(input())
        }
    }
}
