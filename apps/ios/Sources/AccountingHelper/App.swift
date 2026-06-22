#if os(iOS)
import SwiftUI
import UIKit
import CoreGraphics
import ImageIO

/// Root SwiftUI view for the app. The `@main` entry point lives in the thin
/// app target (`apps/ios/App/`), which embeds this view; keeping it here (in the
/// library, behind `#if os(iOS)`) lets the composition root + resources load via
/// `Bundle.module` while staying out of the host (`swift test`) build.
public struct AccountingHelperRootView: View {
    @State private var root = RootModel()
    @Environment(\.scenePhase) private var scenePhase

    public init() {}

    public var body: some View {
        Group {
            if root.isAuthenticated {
                TabView {
                    NavigationStack { HomeView(model: root.homeModel) }
                        .tabItem { SwiftUI.Label("Home", systemImage: "house") }
                    NavigationStack { LogView(model: root.logModel) }
                        .tabItem { SwiftUI.Label("Log", systemImage: "list.bullet") }
                    NavigationStack {
                        SettingsView(model: root.settingsModel, onLogout: { root.logout() })
                    }
                    .tabItem { SwiftUI.Label("Settings", systemImage: "gear") }
                }
            } else {
                LoginView(model: root.loginModel)
            }
        }
        .task { await root.onLaunch() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await root.onForeground() } }
        }
    }
}

/// Composition root: builds the real dependency graph and drives scans.
@MainActor
@Observable
final class RootModel {
    private let keychain: KeychainStore = SystemKeychainStore()
    private let store: ScanStateStore
    private var settings: AppSettings
    private let auth: AuthService
    private var baseURL: URL?
    private var observer: PhotoLibraryObserver?

    let loginModel: LoginViewModel
    let homeModel: HomeViewModel
    let logModel: LogViewModel
    let settingsModel: SettingsViewModel

    var isAuthenticated = false

    init() {
        let kc = SystemKeychainStore()
        let dbPath = RootModel.databasePath()
        // GRDB store; if it cannot open, fail loudly on device (not expected).
        self.store = try! GRDBScanStateStore(path: dbPath)
        let loadedSettings = AppSettingsStore.load()
        self.settings = loadedSettings
        self.auth = AuthService(
            apiFor: { url in URLSessionAPIClient(baseURL: url) },
            keychain: kc)
        self.loginModel = LoginViewModel(auth: auth, deviceName: RootModel.deviceName())
        self.homeModel = HomeViewModel(store: store, syncEnabled: loadedSettings.syncEnabled)
        self.logModel = LogViewModel(store: store)
        self.settingsModel = SettingsViewModel(store: store, settings: loadedSettings,
                                               onSettingsChange: { AppSettingsStore.save($0) })
        // Flip to the authenticated UI immediately after a successful scan. Only
        // start scanning if sync is already enabled (otherwise the user opts in
        // via the Start sync button on Home).
        self.loginModel.onAuthenticated = { [weak self] in
            guard let self else { return }
            self.isAuthenticated = true
            if AppSettingsStore.load().syncEnabled {
                self.registerObserver()
                Task { await self.runScan() }
            }
        }
        // Home's Start/Stop sync button drives setSyncEnabled.
        self.homeModel.onSetSync = { [weak self] on in self?.setSyncEnabled(on) }
    }

    func onLaunch() async {
        isAuthenticated = (try? keychain.read()) != nil
        // Resume an enabled sync automatically after relaunch.
        if isAuthenticated && AppSettingsStore.load().syncEnabled {
            registerObserver()
            await runScan()
        }
    }

    func onForeground() async {
        if loginModel.isAuthenticated && !isAuthenticated {
            isAuthenticated = true
        }
        guard isAuthenticated, AppSettingsStore.load().syncEnabled else { return }
        registerObserver()
        await runScan()
    }

    /// Start/stop the automatic sync. Persisted, so `onLaunch` resumes it after a
    /// relaunch. Turning it on triggers an immediate scan + change observer.
    func setSyncEnabled(_ on: Bool) {
        settings = AppSettingsStore.load()
        settings.syncEnabled = on
        AppSettingsStore.save(settings)
        homeModel.syncEnabled = on
        if on {
            registerObserver()
            Task { await runScan() }
        } else {
            observer?.unregister()
            observer = nil
        }
    }

    func logout() {
        Task {
            await auth.logout(baseURL: currentBaseURL())
            isAuthenticated = false
            observer?.unregister()
            observer = nil
        }
    }

    private func registerObserver() {
        guard observer == nil else { return }
        let obs = PhotoLibraryObserver(onChange: { [weak self] in
            Task { @MainActor in await self?.runScan() }
        })
        obs.register()
        observer = obs
    }

    private func runScan() async {
        guard ((try? keychain.read()) ?? nil) != nil else { return }
        let settings = AppSettingsStore.load()
        guard settings.syncEnabled else { return }
        let photos = PhotoKitPhotoSource()
        if photos.authorizationStatus() == .notDetermined {
            _ = await photos.requestAuthorization()
        }
        // On-device model is optional: if a MobileCLIP package is bundled we use it,
        // otherwise we fall back to the Vision document gate alone (gate → upload).
        var runner: ModelRunner?
        var labels: LabelSet?
        if let modelURL = RootModel.modelURL(),
           let r = try? MobileCLIPRunner(modelURL: modelURL),
           let l = try? LabelSet.bundled() {
            runner = r
            labels = l
        }
        let uploader = DocumentUploader(client: URLSessionAPIClient(baseURL: currentBaseURL()),
                                        tokenProvider: { [keychain] in (try? keychain.read()) ?? nil })
        let coordinator = ScanCoordinator(
            photos: photos, gate: VisionGate(), model: runner, labels: labels,
            uploader: uploader, store: store, settings: settings,
            decode: { data in RootModel.decode(data) })
        _ = await coordinator.scanOnce()
        homeModel.refresh()
        logModel.refresh()
    }

    private func currentBaseURL() -> URL {
        auth.apiBaseURL() ?? baseURL ?? URL(string: "https://invalid.invalid")!
    }

    nonisolated private static func decode(_ data: PhotoData) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data.bytes as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    private static func databasePath() -> String {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("scan.sqlite").path
    }

    private static func modelURL() -> URL? {
        // Models/ is gitignored and populated by Scripts/fetch-model.sh.
        let url = Bundle.main.bundleURL.appendingPathComponent("MobileCLIP-S0-image.mlpackage")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private static func deviceName() -> String {
        UIDevice.current.name
    }

    // TODO(later): BackgroundTasks — register BGTaskScheduler identifiers and
    // schedule a periodic background scan. Out of scope for the MVP.
}
#endif
