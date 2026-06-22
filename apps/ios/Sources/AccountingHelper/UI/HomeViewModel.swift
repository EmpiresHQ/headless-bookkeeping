import Foundation

@MainActor
@Observable
public final class HomeViewModel {
    private let store: ScanStateStore
    public var uploadedCount = 0
    public var ignoredCount = 0
    public var lastScan: Date?
    /// Reflects the persisted sync master switch; the Start/Stop button drives it.
    public var syncEnabled: Bool
    /// Invoked when the user toggles sync, so the composition root can start/stop.
    public var onSetSync: (Bool) -> Void = { _ in }

    public init(store: ScanStateStore, syncEnabled: Bool = false) {
        self.store = store
        self.syncEnabled = syncEnabled
    }

    public func refresh() {
        let c = (try? store.counts()) ?? (uploaded: 0, ignored: 0)
        uploadedCount = c.uploaded
        ignoredCount = c.ignored
    }

    public func toggleSync() {
        syncEnabled.toggle()
        onSetSync(syncEnabled)
    }
}
