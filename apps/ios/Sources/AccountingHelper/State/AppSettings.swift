import Foundation

public struct AppSettings: Equatable, Sendable {
    public var threshold: Double
    public var autoUpload: Bool
    public init(threshold: Double = 0.22, autoUpload: Bool = true) {
        self.threshold = threshold
        self.autoUpload = autoUpload
    }
}

/// UserDefaults-backed persistence for AppSettings (non-secret config only).
public enum AppSettingsStore {
    public static func load(_ defaults: UserDefaults = .standard) -> AppSettings {
        let t = defaults.object(forKey: "threshold") as? Double
        let a = defaults.object(forKey: "autoUpload") as? Bool
        return AppSettings(threshold: t ?? 0.22, autoUpload: a ?? true)
    }
    public static func save(_ s: AppSettings, _ defaults: UserDefaults = .standard) {
        defaults.set(s.threshold, forKey: "threshold")
        defaults.set(s.autoUpload, forKey: "autoUpload")
    }
}
