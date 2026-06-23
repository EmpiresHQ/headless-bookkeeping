import Foundation

public struct AppSettings: Equatable, Sendable {
    public var threshold: Double
    public var autoUpload: Bool
    /// Master switch: when false the app never scans/uploads. Persisted, so an
    /// enabled sync resumes automatically after a relaunch. Default OFF so a
    /// fresh install never touches the library until the user opts in.
    public var syncEnabled: Bool
    /// Max NEW (not-yet-handled) assets processed per scan. Bounds the first run
    /// so it does not sweep the entire photo library at once; each subsequent
    /// scan picks up the next batch (newest first). 0 = unlimited.
    public var maxPerScan: Int
    /// Whether screenshots are scanned. Default OFF: screenshots (weather, chats,
    /// web) are the biggest source of text-gate false positives. Turn on if you
    /// keep e-receipts as screenshots.
    public var includeScreenshots: Bool
    /// Opt-in on-device VLM "second pass" (Qwen 3.5). When on (and on iOS), a small
    /// vision model double-checks gate-passed images and vetoes non-documents
    /// (weather/chat/web screenshots) before upload. Default OFF: it downloads a
    /// ~0.5GB model and needs a recent iPhone.
    public var secondPassEnabled: Bool
    public init(threshold: Double = 0.22, autoUpload: Bool = true,
                syncEnabled: Bool = false, maxPerScan: Int = 30,
                includeScreenshots: Bool = false, secondPassEnabled: Bool = false) {
        self.threshold = threshold
        self.autoUpload = autoUpload
        self.syncEnabled = syncEnabled
        self.maxPerScan = maxPerScan
        self.includeScreenshots = includeScreenshots
        self.secondPassEnabled = secondPassEnabled
    }
}

/// UserDefaults-backed persistence for AppSettings (non-secret config only).
public enum AppSettingsStore {
    public static func load(_ defaults: UserDefaults = .standard) -> AppSettings {
        let t = defaults.object(forKey: "threshold") as? Double
        let a = defaults.object(forKey: "autoUpload") as? Bool
        let s = defaults.object(forKey: "syncEnabled") as? Bool
        let m = defaults.object(forKey: "maxPerScan") as? Int
        let sc = defaults.object(forKey: "includeScreenshots") as? Bool
        let sp = defaults.object(forKey: "secondPassEnabled") as? Bool
        return AppSettings(threshold: t ?? 0.22, autoUpload: a ?? true,
                           syncEnabled: s ?? false, maxPerScan: m ?? 30,
                           includeScreenshots: sc ?? false, secondPassEnabled: sp ?? false)
    }
    public static func save(_ s: AppSettings, _ defaults: UserDefaults = .standard) {
        defaults.set(s.threshold, forKey: "threshold")
        defaults.set(s.autoUpload, forKey: "autoUpload")
        defaults.set(s.syncEnabled, forKey: "syncEnabled")
        defaults.set(s.maxPerScan, forKey: "maxPerScan")
        defaults.set(s.includeScreenshots, forKey: "includeScreenshots")
        defaults.set(s.secondPassEnabled, forKey: "secondPassEnabled")
    }
}
