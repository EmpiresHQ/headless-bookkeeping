#if os(iOS)
import SwiftUI
import UIKit

public struct LogView: View {
    @State private var model: LogViewModel
    @State private var thumbs: [String: UIImage] = [:]
    @State private var showClearConfirm = false

    public init(model: LogViewModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        List(model.entries, id: \.assetLocalId) { entry in
            NavigationLink {
                LogDetailView(entry: entry)
            } label: {
                HStack(spacing: 12) {
                    thumbnail(for: entry.assetLocalId)
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
            }
        }
        .navigationTitle("Log")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Clear", role: .destructive) { showClearConfirm = true }
                    .disabled(model.entries.isEmpty)
            }
        }
        .confirmationDialog("Clear the scan log?", isPresented: $showClearConfirm,
                            titleVisibility: .visible) {
            Button("Clear log", role: .destructive) {
                model.clear()
                thumbs = [:]
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This also lets these photos be re-checked on the next sync.")
        }
        .onAppear { model.refresh() }
        .refreshable { model.refresh() }
    }

    @ViewBuilder
    private func thumbnail(for localId: String) -> some View {
        Group {
            if let img = thumbs[localId] {
                Image(uiImage: img).resizable().aspectRatio(contentMode: .fill)
            } else {
                RoundedRectangle(cornerRadius: 6).fill(.quaternary)
            }
        }
        .frame(width: 48, height: 48)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .task {
            if thumbs[localId] == nil {
                thumbs[localId] = await PhotoThumbnailLoader.shared.image(for: localId, maxPixel: 96)
            }
        }
    }
}
#endif
