@testable import AccountingHelper
import CoreGraphics

final class FakeModelRunner: ModelRunner, @unchecked Sendable {
    var embedding: [Float] = [1, 0]
    var error: Error?
    func imageEmbedding(_ image: CGImage) async throws -> [Float] {
        if let error { throw error }
        return embedding
    }
}

final class FakeGate: ImageGate, @unchecked Sendable {
    var passes = true
    func looksLikeDocument(_ image: CGImage) async -> Bool { passes }
}
