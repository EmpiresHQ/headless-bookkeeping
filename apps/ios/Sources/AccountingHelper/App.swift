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
        self.homeModel = HomeViewModel(store: store)
        self.logModel = LogViewModel(store: store)
        self.settingsModel = SettingsViewModel(store: store, settings: loadedSettings,
                                               onSettingsChange: { AppSettingsStore.save($0) })
        // Flip to the authenticated UI immediately after a successful scan,
        // instead of waiting for the next foreground / relaunch.
        self.loginModel.onAuthenticated = { [weak self] in
            guard let self else { return }
            self.isAuthenticated = true
            self.registerObserver()
            Task { await self.runScan() }
        }
    }

    func onLaunch() async {
        isAuthenticated = (try? keychain.read()) != nil
        if isAuthenticated {
            registerObserver()
            await runScan()
        }
    }

    func onForeground() async {
        if loginModel.isAuthenticated && !isAuthenticated {
            isAuthenticated = true
            registerObserver()
        }
        guard isAuthenticated else { return }
        await runScan()
    }

    func logout() {
        Task {
            if let baseURL { await auth.logout(baseURL: baseURL) }
            else { await auth.logout(baseURL: URL(string: "https://invalid.invalid")!) }
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
        let photos = PhotoKitPhotoSource()
        if photos.authorizationStatus() == .notDetermined {
            _ = await photos.requestAuthorization()
        }
        guard let labels = try? LabelSet.bundled() else { return }
        // Model is loaded from the downloaded package; if absent, scanning is a no-op.
        guard let modelURL = RootModel.modelURL(),
              let runner = try? MobileCLIPRunner(modelURL: modelURL) else { return }
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
        baseURL ?? URL(string: "https://invalid.invalid")!
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
