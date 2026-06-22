import Foundation

@MainActor
@Observable
public final class LogViewModel {
    private let store: ScanStateStore
    public var entries: [LogEntry] = []
    public init(store: ScanStateStore) { self.store = store }
    public func refresh() { entries = (try? store.recentLog(limit: 200)) ?? [] }

    /// Clears the scan log. Because each log row IS the per-asset cursor, this also
    /// makes those photos eligible to be re-examined on the next scan (useful
    /// after tuning the gate/threshold).
    public func clear() {
        try? store.reset()
        refresh()
    }
}
