import Foundation

@MainActor
@Observable
public final class SettingsViewModel {
    private let store: ScanStateStore
    private let onSettingsChange: (AppSettings) -> Void
    public var settings: AppSettings { didSet { onSettingsChange(settings) } }

    public init(store: ScanStateStore, settings: AppSettings,
                onSettingsChange: @escaping (AppSettings) -> Void) {
        self.store = store
        self.settings = settings
        self.onSettingsChange = onSettingsChange
    }

    public func resetCursor() { try? store.reset() }
}
