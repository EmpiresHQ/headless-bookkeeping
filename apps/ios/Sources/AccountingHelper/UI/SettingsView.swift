#if os(iOS)
import SwiftUI

public struct SettingsView: View {
    @State private var model: SettingsViewModel
    private let onLogout: () -> Void

    public init(model: SettingsViewModel, onLogout: @escaping () -> Void) {
        _model = State(initialValue: model)
        self.onLogout = onLogout
    }

    public var body: some View {
        Form {
            Section("Pre-check") {
                Toggle("Auto-upload", isOn: $model.settings.autoUpload)
                VStack(alignment: .leading) {
                    Text("Threshold: \(model.settings.threshold, specifier: "%.2f")")
                    Slider(value: $model.settings.threshold, in: 0...1)
                }
            }
            Section {
                Stepper("Max per scan: \(model.settings.maxPerScan)",
                        value: $model.settings.maxPerScan, in: 0...500, step: 10)
            } footer: {
                Text("How many new photos each scan processes (newest first). 0 = no limit. Keeps the first scan from sweeping your whole library at once.")
            }
            Section {
                Toggle("Include screenshots", isOn: $model.settings.includeScreenshots)
            } footer: {
                Text("Off by default. Screenshots (weather, chats, web) are the main source of false uploads. Turn on only if you keep e-receipts as screenshots.")
            }
            Section {
                Toggle("AI second pass (Qwen 3.5)", isOn: $model.settings.secondPassEnabled)
            } footer: {
                Text("Off by default. After the quick text check, a small on-device AI model double-checks each photo is actually a receipt or invoice before uploading — cutting false uploads from weather, chat, and web screenshots. The ~0.5GB model is bundled in the app (no download), runs fully on-device, and needs a recent iPhone.")
            }
            Section {
                // `.borderless` keeps each button independently hit-testable inside a
                // Form row. Without it, stacking two buttons in one Section makes the
                // default (.automatic) style swallow taps, so the row needs several
                // clicks before it registers.
                Button("Reset scan state", role: .destructive) {
                    model.resetCursor()
                }
                .buttonStyle(.borderless)
                Button("Log out", role: .destructive, action: onLogout)
                    .buttonStyle(.borderless)
            }
        }
        .navigationTitle("Settings")
    }
}
#endif
