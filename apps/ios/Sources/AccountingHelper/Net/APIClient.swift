import Foundation

/// Compile-time marker proving the module links (kept for the smoke test).
public enum AccountingHelperModuleMarker {
    public static let ok = true
}

public struct APIRequest: Sendable {
    public var method: String
    public var path: String
    public var body: Data?
    public var contentType: String?
    public var bearer: String?
    public init(method: String, path: String, body: Data? = nil,
                contentType: String? = nil, bearer: String? = nil) {
        self.method = method; self.path = path; self.body = body
        self.contentType = contentType; self.bearer = bearer
    }
}

public struct APIResponse: Sendable {
    public let status: Int
    public let data: Data
    public init(status: Int, data: Data) {
        self.status = status
        self.data = data
    }
}

public protocol APIClient: Sendable {
    func send(_ req: APIRequest) async throws -> APIResponse
}

public final class URLSessionAPIClient: APIClient {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func send(_ req: APIRequest) async throws -> APIResponse {
        let url = URL(string: req.path, relativeTo: baseURL) ?? baseURL.appendingPathComponent(req.path)
        var urlReq = URLRequest(url: url.absoluteURL)
        urlReq.httpMethod = req.method
        urlReq.httpBody = req.body
        if let ct = req.contentType { urlReq.setValue(ct, forHTTPHeaderField: "Content-Type") }
        if let bearer = req.bearer { urlReq.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await session.data(for: urlReq)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        return APIResponse(status: status, data: data)
    }
}
