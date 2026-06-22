@testable import AccountingHelper
import Foundation

final class FakeAPIClient: APIClient, @unchecked Sendable {
    private(set) var sent: [APIRequest] = []
    var responses: [Result<APIResponse, Error>] = []
    func send(_ req: APIRequest) async throws -> APIResponse {
        sent.append(req)
        guard !responses.isEmpty else { return APIResponse(status: 200, data: Data()) }
        switch responses.removeFirst() {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }
}
