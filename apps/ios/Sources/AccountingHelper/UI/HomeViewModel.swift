import Foundation

@MainActor
@Observable
public final class HomeViewModel {
    private let store: ScanStateStore
    public var uploadedCount = 0
    public var ignoredCount = 0
    public var lastScan: Date?

    public init(store: ScanStateStore) { self.store = store }

    public func refresh() {
        let c = (try? store.counts()) ?? (uploaded: 0, ignored: 0)
        uploadedCount = c.uploaded
        ignoredCount = c.ignored
    }
}
