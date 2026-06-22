#if os(iOS)
import SwiftUI
import UIKit

/// Detail for a single scan-log entry: a larger preview of the photo plus its
/// pre-check metadata.
public struct LogDetailView: View {
    private let entry: LogEntry
    @State private var image: UIImage?

    public init(entry: LogEntry) {
        self.entry = entry
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                Group {
                    if let image {
                        Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
                    } else {
                        RoundedRectangle(cornerRadius: 12).fill(.quaternary)
                            .frame(height: 300)
                            .overlay(ProgressView())
                    }
                }
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 12))

                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("Outcome", value: entry.outcome.rawValue)
                    LabeledContent("Label", value: entry.topLabel)
                    LabeledContent("Score", value: String(format: "%.3f", entry.score))
                    LabeledContent("When", value: entry.at.formatted())
                    LabeledContent("Asset", value: entry.assetLocalId)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding()
        }
        .navigationTitle(entry.outcome.rawValue.capitalized)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            image = await PhotoThumbnailLoader.shared.image(for: entry.assetLocalId, maxPixel: 1200)
        }
    }
}
#endif
