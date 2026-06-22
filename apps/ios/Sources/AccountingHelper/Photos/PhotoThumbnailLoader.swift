#if os(iOS)
import Photos
import UIKit

/// Loads (and caches) UIImage thumbnails for photo-library assets by local id.
/// UI-only eye-candy for the Log screen; not part of the scan pipeline.
@MainActor
public final class PhotoThumbnailLoader {
    public static let shared = PhotoThumbnailLoader()
    private var cache: [String: UIImage] = [:]

    public init() {}

    public func image(for localId: String, maxPixel: CGFloat) async -> UIImage? {
        let key = "\(localId)@\(Int(maxPixel))"
        if let cached = cache[key] { return cached }

        let fetch = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
        guard let asset = fetch.firstObject else { return nil }

        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat // single (non-degraded) callback
        options.resizeMode = .exact
        let target = CGSize(width: maxPixel, height: maxPixel)

        let image: UIImage? = await withCheckedContinuation { continuation in
            let resumed = ResumeGuard()
            PHImageManager.default().requestImage(
                for: asset, targetSize: target, contentMode: .aspectFill, options: options
            ) { image, info in
                // requestImage can fire more than once; resume the continuation only once.
                let isDegraded = (info?[PHImageResultIsDegradedKey] as? Bool) ?? false
                if isDegraded { return }
                resumed.once { continuation.resume(returning: image) }
            }
        }
        if let image { cache[key] = image }
        return image
    }
}

/// Ensures a continuation is resumed at most once across multiple PHImageManager callbacks.
private final class ResumeGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func once(_ body: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard !done else { return }
        done = true
        body()
    }
}
#endif
