@testable import AccountingHelper
import Foundation

final class FakeScanStateStore: ScanStateStore, @unchecked Sendable {
    // Cursor + counts: one entry per asset.
    private(set) var state: [String: LogEntry] = [:]
    // Display log: append-only history.
    private(set) var log: [LogEntry] = []

    func status(of id: String) throws -> AssetOutcome? { state[id]?.outcome }
    func record(_ entry: LogEntry) throws {
        state[entry.assetLocalId] = entry
        log.append(entry)
    }
    func recentLog(limit: Int) throws -> [LogEntry] {
        Array(log.sorted { $0.at > $1.at }.prefix(limit))
    }
    func counts() throws -> (uploaded: Int, ignored: Int) {
        (state.values.filter { $0.outcome == .uploaded }.count,
         state.values.filter { $0.outcome == .ignored }.count)
    }
    func clearLog() throws { log.removeAll() }
    func reset() throws { state.removeAll(); log.removeAll() }
}
