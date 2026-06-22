import SwiftUI
import AccountingHelper

/// Thin `@main` entry point for the iOS app target. All UI, state, and the
/// composition root live in the `AccountingHelper` SPM library (so resources load
/// via `Bundle.module` and the logic is unit-tested on the host); this target
/// just hosts the app lifecycle and embeds the library's root view.
@main
struct AccountingHelperApp: App {
    var body: some Scene {
        WindowGroup {
            AccountingHelperRootView()
        }
    }
}
