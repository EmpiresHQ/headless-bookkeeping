import Foundation

public struct Label: Equatable, Sendable {
    public let name: String
    public let prompt: String
    public let isFinancial: Bool
    public let embedding: [Float]
    public init(name: String, prompt: String, isFinancial: Bool, embedding: [Float]) {
        self.name = name; self.prompt = prompt
        self.isFinancial = isFinancial; self.embedding = embedding
    }
}

public struct LabelSet: Sendable {
    public let labels: [Label]
    public init(labels: [Label]) { self.labels = labels }

    private struct Wire: Decodable {
        struct L: Decodable { let name: String; let prompt: String; let financial: Bool; let embedding: [Float] }
        let labels: [L]
    }

    public static func load(from data: Data) throws -> LabelSet {
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        return LabelSet(labels: wire.labels.map {
            Label(name: $0.name, prompt: $0.prompt, isFinancial: $0.financial, embedding: $0.embedding)
        })
    }

    public static func bundled() throws -> LabelSet {
        guard let url = Bundle.module.url(forResource: "label-embeddings", withExtension: "json") else {
            throw NSError(domain: "LabelSet", code: 1)
        }
        return try load(from: Data(contentsOf: url))
    }
}
