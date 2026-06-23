#if os(iOS)
import SwiftUI

public struct HomeView: View {
    @State private var model: HomeViewModel

    public init(model: HomeViewModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        List {
            Section("Sync") {
                LabeledContent("Status", value: model.syncEnabled ? "On" : "Off")
                Button(model.syncEnabled ? "Stop sync" : "Start sync") {
                    model.toggleSync()
                }
                // `.borderless` makes the button itself the tap target inside the List
                // row; the default style lets the whole cell intercept and drop taps,
                // so the button needs several clicks before it fires.
                .buttonStyle(.borderless)
                .tint(model.syncEnabled ? .red : .accentColor)
            }
            Section("Scan results") {
                LabeledContent("Uploaded", value: "\(model.uploadedCount)")
                LabeledContent("Ignored", value: "\(model.ignoredCount)")
            }
        }
        .navigationTitle("Home")
        .onAppear { model.refresh() }
        .refreshable { model.refresh() }
    }
}
#endif
