import Foundation
import GRDB

public enum AssetOutcome: String, Codable, Sendable { case uploaded, ignored, failed }

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
    /// Clears ONLY the display log. The per-asset cursor (status) and counts are
    /// kept, so cleared photos are NOT re-scanned.
    func clearLog() throws
    /// Full wipe: cursor + counts + log. Cleared photos become eligible to re-scan.
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
            // Per-asset cursor + counts: one row per asset (upsert).
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS asset_state (
                    asset_local_id TEXT PRIMARY KEY,
                    outcome TEXT NOT NULL,
                    top_label TEXT NOT NULL,
                    score DOUBLE NOT NULL,
                    at DOUBLE NOT NULL
                )
            """)
            // Display log: append-only history, independent of the cursor so it
            // can be cleared without re-scanning.
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS scan_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    asset_local_id TEXT NOT NULL,
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
            // Cursor + counts: one row per asset.
            try db.execute(sql: """
                INSERT INTO asset_state (asset_local_id, outcome, top_label, score, at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(asset_local_id) DO UPDATE SET
                    outcome = excluded.outcome, top_label = excluded.top_label,
                    score = excluded.score, at = excluded.at
            """, arguments: [entry.assetLocalId, entry.outcome.rawValue,
                             entry.topLabel, entry.score, entry.at.timeIntervalSince1970])
            // Display log: append.
            try db.execute(sql: """
                INSERT INTO scan_log (asset_local_id, outcome, top_label, score, at)
                VALUES (?, ?, ?, ?, ?)
            """, arguments: [entry.assetLocalId, entry.outcome.rawValue,
                             entry.topLabel, entry.score, entry.at.timeIntervalSince1970])
        }
    }

    public func recentLog(limit: Int) throws -> [LogEntry] {
        try queue.read { db in
            try Row.fetchAll(db,
                sql: "SELECT * FROM scan_log ORDER BY at DESC, id DESC LIMIT ?", arguments: [limit])
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

    public func clearLog() throws {
        try queue.write { db in try db.execute(sql: "DELETE FROM scan_log") }
    }

    public func reset() throws {
        try queue.write { db in
            try db.execute(sql: "DELETE FROM asset_state")
            try db.execute(sql: "DELETE FROM scan_log")
        }
    }
}
