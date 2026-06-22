#if os(iOS)
import SwiftUI

public struct HomeView: View {
    @State private var model: HomeViewModel

    public init(model: HomeViewModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        List {
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
