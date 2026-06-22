import Foundation

public struct UploadInput: Sendable {
    public let assetLocalId: String
    public let capturedAt: Date
    public let data: PhotoData
    public let precheck: PrecheckResult
    public init(assetLocalId: String, capturedAt: Date, data: PhotoData, precheck: PrecheckResult) {
        self.assetLocalId = assetLocalId; self.capturedAt = capturedAt
        self.data = data; self.precheck = precheck
    }
}

public enum UploadError: Error, Equatable { case unauthorized; case server(Int) }

public final class DocumentUploader {
    private let client: APIClient
    private let tokenProvider: @Sendable () -> String?

    public init(client: APIClient, tokenProvider: @escaping @Sendable () -> String?) {
        self.client = client
        self.tokenProvider = tokenProvider
    }

    public func upload(_ input: UploadInput) async throws -> Bool {
        var body = MultipartBody(boundary: "Boundary-\(UUID().uuidString)")
        body.addField(name: "channel", value: "ios_photo_library")
        body.addField(name: "assetLocalId", value: input.assetLocalId)
        let iso = ISO8601DateFormatter()
        body.addField(name: "capturedAt", value: iso.string(from: input.capturedAt))
        let precheckJSON = String(data: try JSONEncoder().encode(input.precheck), encoding: .utf8) ?? "{}"
        body.addField(name: "precheck", value: precheckJSON)
        let contentType = mime(for: input.data.utiType)
        body.addFile(name: "file", filename: input.data.filename,
                     contentType: contentType, data: input.data.bytes)
        let (ct, payload) = body.finished()

        let resp = try await client.send(APIRequest(
            method: "POST", path: "/api/documents", body: payload,
            contentType: ct, bearer: tokenProvider()))
        switch resp.status {
        case 200...299: return true
        case 401: throw UploadError.unauthorized
        default: throw UploadError.server(resp.status)
        }
    }

    private func mime(for uti: String) -> String {
        switch uti {
        case "public.heic", "public.heif": return "image/heic"
        case "public.jpeg": return "image/jpeg"
        case "public.png": return "image/png"
        default: return "application/octet-stream"
        }
    }
}
