import Foundation

public struct ModelManifest: Decodable, Equatable, Sendable {
    public let version: String
    public let url: URL
    public let sha256: String

    public static func bundled() throws -> ModelManifest {
        guard let u = Bundle.module.url(forResource: "model-manifest", withExtension: "json") else {
            throw NSError(domain: "ModelManifest", code: 1)
        }
        return try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: u))
    }
}
