import Foundation

@MainActor
@Observable
public final class SettingsViewModel {
    private let store: ScanStateStore
    private let onSettingsChange: (AppSettings) -> Void
    /// Fired after a full reset wipes the store, so the composition root can refresh
    /// the Home counts and Log entries (in-memory caches that would otherwise stay
    /// stale until their tab re-appears).
    private let onReset: () -> Void
    public var settings: AppSettings { didSet { onSettingsChange(settings) } }

    public init(store: ScanStateStore, settings: AppSettings,
                onSettingsChange: @escaping (AppSettings) -> Void,
                onReset: @escaping () -> Void = {}) {
        self.store = store
        self.settings = settings
        self.onSettingsChange = onSettingsChange
        self.onReset = onReset
    }

    public func resetCursor() {
        try? store.reset()
        onReset()
    }
}
