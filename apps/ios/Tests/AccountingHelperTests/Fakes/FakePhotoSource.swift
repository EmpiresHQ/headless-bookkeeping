@testable import AccountingHelper
import Foundation

final class FakePhotoSource: PhotoSource, @unchecked Sendable {
    let assets: [PhotoAsset]
    let data: [String: PhotoData]
    var status: PhotoAuthStatus = .authorized
    init(assets: [PhotoAsset], data: [String: PhotoData]) { self.assets = assets; self.data = data }
    func authorizationStatus() -> PhotoAuthStatus { status }
    func requestAuthorization() async -> PhotoAuthStatus { status }
    func enumerateImages() async -> [PhotoAsset] { assets }
    func loadOriginal(localId: String) async throws -> PhotoData {
        guard let d = data[localId] else { throw PhotoSourceError.assetNotFound }
        return d
    }
}
