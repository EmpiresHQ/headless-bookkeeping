import Testing
import Foundation
@testable import AccountingHelper

@Suite struct PrecheckDecisionTests {
    private func labels() -> LabelSet {
        LabelSet(labels: [
            Label(name: "receipt", prompt: "", isFinancial: true,  embedding: [1, 0]),
            Label(name: "selfie",  prompt: "", isFinancial: false, embedding: [0, 1]),
        ])
    }

    @Test func uploadsWhenFinancialWinsAboveThreshold() {
        let r = PrecheckDecision.decide(imageEmbedding: [1, 0], labels: labels(), threshold: 0.5)
        #expect(r.decision == .upload)
        #expect(r.topLabel == "receipt")
        #expect(abs(r.topScore - 1.0) < 1e-6)
    }

    @Test func ignoresWhenNonFinancialWins() {
        let r = PrecheckDecision.decide(imageEmbedding: [0, 1], labels: labels(), threshold: 0.5)
        #expect(r.decision == .ignore)
        #expect(r.topLabel == "selfie")
    }

    @Test func ignoresWhenFinancialWinsButBelowThreshold() {
        // image leans financial but weakly (cos ~0.73 vs ~0.68) yet below threshold 0.8
        let r = PrecheckDecision.decide(imageEmbedding: [0.45, 0.42], labels: labels(), threshold: 0.8)
        #expect(r.decision == .ignore)
    }

    @Test func scoresIncludeAllLabels() {
        let r = PrecheckDecision.decide(imageEmbedding: [1, 0], labels: labels(), threshold: 0.5)
        #expect(Set(r.scores.map(\.name)) == ["receipt", "selfie"])
    }
}
