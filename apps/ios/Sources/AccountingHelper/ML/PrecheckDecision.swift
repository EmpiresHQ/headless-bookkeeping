import Foundation

public struct LabelScore: Equatable, Sendable, Codable {
    public let name: String
    public let score: Double
    public init(name: String, score: Double) { self.name = name; self.score = score }
}

public enum PrecheckDecisionKind: String, Codable, Sendable { case upload, ignore }

public struct PrecheckResult: Equatable, Sendable, Codable {
    public let decision: PrecheckDecisionKind
    public let topLabel: String
    public let topScore: Double
    public let scores: [LabelScore]
    public init(decision: PrecheckDecisionKind, topLabel: String, topScore: Double, scores: [LabelScore]) {
        self.decision = decision; self.topLabel = topLabel
        self.topScore = topScore; self.scores = scores
    }
}

public enum PrecheckDecision {
    public static func decide(imageEmbedding: [Float], labels: LabelSet, threshold: Double) -> PrecheckResult {
        let scored = labels.labels.map { label -> (Label, Double) in
            (label, cosine(imageEmbedding, label.embedding))
        }
        let all = scored.map { LabelScore(name: $0.0.name, score: $0.1) }
        let top = scored.max { $0.1 < $1.1 }!
        let bestFinancial = scored.filter { $0.0.isFinancial }.map(\.1).max() ?? -1
        let bestNonFinancial = scored.filter { !$0.0.isFinancial }.map(\.1).max() ?? -1
        let decision: PrecheckDecisionKind =
            (bestFinancial > bestNonFinancial && bestFinancial >= threshold) ? .upload : .ignore
        return PrecheckResult(decision: decision, topLabel: top.0.name, topScore: top.1, scores: all)
    }

    private static func cosine(_ a: [Float], _ b: [Float]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot: Double = 0, na: Double = 0, nb: Double = 0
        for i in a.indices {
            dot += Double(a[i]) * Double(b[i])
            na += Double(a[i]) * Double(a[i])
            nb += Double(b[i]) * Double(b[i])
        }
        guard na > 0, nb > 0 else { return 0 }
        return dot / (na.squareRoot() * nb.squareRoot())
    }
}
