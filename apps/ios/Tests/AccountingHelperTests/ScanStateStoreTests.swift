import Testing
import Foundation
import GRDB
@testable import AccountingHelper

@Suite struct ScanStateStoreTests {
    private func makeStore() throws -> GRDBScanStateStore {
        try GRDBScanStateStore(queue: DatabaseQueue()) // in-memory
    }

    @Test func recordsAndReadsStatus() throws {
        let store = try makeStore()
        #expect(try store.status(of: "A1") == nil)
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded,
                                  topLabel: "purchase_receipt", score: 0.9,
                                  at: Date(timeIntervalSince1970: 100)))
        #expect(try store.status(of: "A1") == .uploaded)
    }

    @Test func counts() throws {
        let store = try makeStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        try store.record(LogEntry(assetLocalId: "A2", outcome: .ignored, topLabel: "selfie", score: 0.1, at: Date()))
        try store.record(LogEntry(assetLocalId: "A3", outcome: .uploaded, topLabel: "r", score: 0.8, at: Date()))
        let c = try store.counts()
        #expect(c.uploaded == 2)
        #expect(c.ignored == 1)
    }

    @Test func recentLogIsNewestFirst() throws {
        let store = try makeStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date(timeIntervalSince1970: 1)))
        try store.record(LogEntry(assetLocalId: "A2", outcome: .ignored, topLabel: "s", score: 0.1, at: Date(timeIntervalSince1970: 2)))
        let log = try store.recentLog(limit: 10)
        #expect(log.map(\.assetLocalId) == ["A2", "A1"])
    }

    @Test func resetClearsEverything() throws {
        let store = try makeStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        try store.reset()
        #expect(try store.status(of: "A1") == nil)
        #expect(try store.counts().uploaded == 0)
    }

    @Test func clearLogKeepsCursorAndCounts() throws {
        let store = try makeStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        try store.clearLog()
        // Log is empty…
        #expect(try store.recentLog(limit: 10).isEmpty)
        // …but the cursor + counts survive (no re-scan).
        #expect(try store.status(of: "A1") == .uploaded)
        #expect(try store.counts().uploaded == 1)
    }

    @Test func idempotentRecordKeepsSingleRow() throws {
        let store = try makeStore()
        let e = LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date())
        try store.record(e)
        try store.record(e) // same id again — must not double count
        #expect(try store.counts().uploaded == 1)
    }
}
