import SwiftUI

/// Thin `@main` entry point for the iOS app target. The app target compiles the
/// `Sources/AccountingHelper` sources directly (so `Bundle.main` holds resources);
/// the same sources are ALSO built as an SPM library for `swift test`. This file
/// just hosts the app lifecycle and embeds the shared root view.
@main
struct AccountingHelperApp: App {
    var body: some Scene {
        WindowGroup {
            AccountingHelperRootView()
        }
    }
}
