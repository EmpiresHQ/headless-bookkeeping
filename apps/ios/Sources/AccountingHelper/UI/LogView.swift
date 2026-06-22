#if os(iOS)
import SwiftUI

public struct LogView: View {
    @State private var model: LogViewModel

    public init(model: LogViewModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        List(model.entries, id: \.assetLocalId) { entry in
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(entry.topLabel).font(.body)
                    Spacer()
                    Text(entry.outcome.rawValue)
                        .font(.caption)
                        .foregroundStyle(entry.outcome == .uploaded ? .green : .secondary)
                }
                Text(String(format: "score %.3f · %@", entry.score, entry.at.formatted()))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Log")
        .onAppear { model.refresh() }
        .refreshable { model.refresh() }
    }
}
#endif
