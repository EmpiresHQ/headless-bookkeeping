import CoreGraphics

public protocol ImageGate: Sendable {
    func looksLikeDocument(_ image: CGImage) async -> Bool
}

public protocol ModelRunner: Sendable {
    func imageEmbedding(_ image: CGImage) async throws -> [Float]
}
