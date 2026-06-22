import Foundation
import GRDB

public enum AssetOutcome: String, Codable, Sendable { case uploaded, ignored }

public struct LogEntry: Equatable, Sendable {
    public let assetLocalId: String
    public let outcome: AssetOutcome
    public let topLabel: String
    public let score: Double
    public let at: Date
    public init(assetLocalId: String, outcome: AssetOutcome, topLabel: String, score: Double, at: Date) {
        self.assetLocalId = assetLocalId; self.outcome = outcome
        self.topLabel = topLabel; self.score = score; self.at = at
    }
}

public protocol ScanStateStore: Sendable {
    func status(of id: String) throws -> AssetOutcome?
    func record(_ entry: LogEntry) throws
    func recentLog(limit: Int) throws -> [LogEntry]
    func counts() throws -> (uploaded: Int, ignored: Int)
    func reset() throws
}

public final class GRDBScanStateStore: ScanStateStore {
    private let queue: DatabaseQueue

    public init(queue: DatabaseQueue) throws {
        self.queue = queue
        try migrate()
    }

    public convenience init(path: String) throws {
        try self.init(queue: try DatabaseQueue(path: path))
    }

    private func migrate() throws {
        try queue.write { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS asset_state (
                    asset_local_id TEXT PRIMARY KEY,
                    outcome TEXT NOT NULL,
                    top_label TEXT NOT NULL,
                    score DOUBLE NOT NULL,
                    at DOUBLE NOT NULL
                )
            """)
        }
    }

    public func status(of id: String) throws -> AssetOutcome? {
        try queue.read { db in
            guard let raw = try String.fetchOne(db,
                sql: "SELECT outcome FROM asset_state WHERE asset_local_id = ?", arguments: [id])
            else { return nil }
            return AssetOutcome(rawValue: raw)
        }
    }

    public func record(_ entry: LogEntry) throws {
        try queue.write { db in
            try db.execute(sql: """
                INSERT INTO asset_state (asset_local_id, outcome, top_label, score, at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(asset_local_id) DO UPDATE SET
                    outcome = excluded.outcome, top_label = excluded.top_label,
                    score = excluded.score, at = excluded.at
            """, arguments: [entry.assetLocalId, entry.outcome.rawValue,
                             entry.topLabel, entry.score, entry.at.timeIntervalSince1970])
        }
    }

    public func recentLog(limit: Int) throws -> [LogEntry] {
        try queue.read { db in
            try Row.fetchAll(db,
                sql: "SELECT * FROM asset_state ORDER BY at DESC LIMIT ?", arguments: [limit])
            .map { row in
                LogEntry(assetLocalId: row["asset_local_id"],
                         outcome: AssetOutcome(rawValue: row["outcome"])!,
                         topLabel: row["top_label"], score: row["score"],
                         at: Date(timeIntervalSince1970: row["at"]))
            }
        }
    }

    public func counts() throws -> (uploaded: Int, ignored: Int) {
        try queue.read { db in
            let up = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM asset_state WHERE outcome = 'uploaded'") ?? 0
            let ig = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM asset_state WHERE outcome = 'ignored'") ?? 0
            return (up, ig)
        }
    }

    public func reset() throws {
        try queue.write { db in try db.execute(sql: "DELETE FROM asset_state") }
    }
}
