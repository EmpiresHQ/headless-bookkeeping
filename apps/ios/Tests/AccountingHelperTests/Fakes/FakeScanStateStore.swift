@testable import AccountingHelper
import Foundation

final class FakeScanStateStore: ScanStateStore, @unchecked Sendable {
    private(set) var entries: [String: LogEntry] = [:]
    func status(of id: String) throws -> AssetOutcome? { entries[id]?.outcome }
    func record(_ entry: LogEntry) throws { entries[entry.assetLocalId] = entry }
    func recentLog(limit: Int) throws -> [LogEntry] {
        Array(entries.values.sorted { $0.at > $1.at }.prefix(limit))
    }
    func counts() throws -> (uploaded: Int, ignored: Int) {
        (entries.values.filter { $0.outcome == .uploaded }.count,
         entries.values.filter { $0.outcome == .ignored }.count)
    }
    func reset() throws { entries.removeAll() }
}
