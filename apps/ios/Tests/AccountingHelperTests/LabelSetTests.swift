import Testing
import Foundation
@testable import AccountingHelper

@Suite struct LabelSetTests {
    @Test func loadsLabelsWithFinancialFlagAndEmbedding() throws {
        let json = """
        {"dim":2,"labels":[
          {"name":"purchase_receipt","prompt":"a photo of a purchase receipt","financial":true,"embedding":[0.1,0.2]},
          {"name":"selfie","prompt":"a selfie","financial":false,"embedding":[0.3,0.4]}
        ]}
        """.data(using: .utf8)!
        let set = try LabelSet.load(from: json)
        #expect(set.labels.count == 2)
        #expect(set.labels[0].name == "purchase_receipt")
        #expect(set.labels[0].isFinancial)
        #expect(set.labels[0].embedding == [0.1, 0.2])
        #expect(!set.labels[1].isFinancial)
    }

    @Test func bundledLabelSetHasFinancialAndNonFinancial() throws {
        let set = try LabelSet.bundled()
        #expect(set.labels.contains { $0.isFinancial })
        #expect(set.labels.contains { !$0.isFinancial })
        // every embedding has the same dimension
        let dims = Set(set.labels.map { $0.embedding.count })
        #expect(dims.count == 1)
    }
}
