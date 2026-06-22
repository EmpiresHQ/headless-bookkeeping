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
                Button("Reset scan state", role: .destructive) {
                    model.resetCursor()
                }
                Button("Log out", role: .destructive, action: onLogout)
            }
        }
        .navigationTitle("Settings")
    }
}
#endif
