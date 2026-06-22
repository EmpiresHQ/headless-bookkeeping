import Foundation

@MainActor
@Observable
public final class LogViewModel {
    private let store: ScanStateStore
    public var entries: [LogEntry] = []
    public init(store: ScanStateStore) { self.store = store }
    public func refresh() { entries = (try? store.recentLog(limit: 200)) ?? [] }
}
