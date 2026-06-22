import Foundation

@MainActor
@Observable
public final class LogViewModel {
    private let store: ScanStateStore
    public var entries: [LogEntry] = []
    public init(store: ScanStateStore) { self.store = store }
    public func refresh() { entries = (try? store.recentLog(limit: 200)) ?? [] }

    /// Clears ONLY the display log. The per-asset cursor and counts are kept, so
    /// cleared photos are NOT re-scanned or re-uploaded.
    public func clear() {
        try? store.clearLog()
        refresh()
    }
}
