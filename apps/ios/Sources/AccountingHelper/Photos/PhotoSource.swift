import Foundation

public protocol PhotoSource: Sendable {
    func authorizationStatus() -> PhotoAuthStatus
    func requestAuthorization() async -> PhotoAuthStatus
    func enumerateImages() async -> [PhotoAsset]
    func loadOriginal(localId: String) async throws -> PhotoData
}

public enum PhotoSourceError: Error { case assetNotFound, dataUnavailable }

#if os(iOS)
import Photos

public final class PhotoKitPhotoSource: PhotoSource {
    public init() {}

    private func map(_ s: PHAuthorizationStatus) -> PhotoAuthStatus {
        switch s {
        case .authorized: return .authorized
        case .limited: return .limited
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }

    public func authorizationStatus() -> PhotoAuthStatus {
        map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    public func requestAuthorization() async -> PhotoAuthStatus {
        await withCheckedContinuation { c in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { c.resume(returning: self.map($0)) }
        }
    }

    public func enumerateImages() async -> [PhotoAsset] {
        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let result = PHAsset.fetchAssets(with: opts)
        var assets: [PhotoAsset] = []
        result.enumerateObjects { asset, _, _ in
            assets.append(PhotoAsset(localId: asset.localIdentifier,
                                     capturedAt: asset.creationDate ?? Date(timeIntervalSince1970: 0)))
        }
        return assets
    }

    public func loadOriginal(localId: String) async throws -> PhotoData {
        let fetch = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
        guard let asset = fetch.firstObject else { throw PhotoSourceError.assetNotFound }
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first(where: { $0.type == .photo }) ?? resources.first else {
            throw PhotoSourceError.dataUnavailable
        }
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        let collector = DataCollector()
        return try await withCheckedThrowingContinuation { c in
            PHAssetResourceManager.default().requestData(for: resource, options: options) { chunk in
                collector.append(chunk)
            } completionHandler: { error in
                if let error { c.resume(throwing: error) }
                else { c.resume(returning: PhotoData(bytes: collector.data,
                                                     utiType: resource.uniformTypeIdentifier,
                                                     filename: resource.originalFilename)) }
            }
        }
    }
}

/// Accumulates streamed asset-resource chunks across the request callbacks.
private final class DataCollector: @unchecked Sendable {
    private(set) var data = Data()
    func append(_ chunk: Data) { data.append(chunk) }
}
#endif
