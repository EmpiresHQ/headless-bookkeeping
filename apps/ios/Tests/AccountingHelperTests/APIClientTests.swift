import Testing
import Foundation
@testable import AccountingHelper

@Suite struct APIClientTests {
    @Test func buildsAuthorizedRequest() async throws {
        URLProtocolStub.reset()
        URLProtocolStub.responder = { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!
            return (resp, Data())
        }
        defer { URLProtocolStub.reset() }

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        let client = URLSessionAPIClient(baseURL: URL(string: "https://api.test")!,
                                         session: URLSession(configuration: config))
        let resp = try await client.send(APIRequest(method: "GET", path: "/api/ping", bearer: "sess-1"))
        #expect(resp.status == 204)

        let sent = URLProtocolStub.lastRequest
        #expect(sent?.url?.absoluteString == "https://api.test/api/ping")
        #expect(sent?.value(forHTTPHeaderField: "Authorization") == "Bearer sess-1")
    }
}
