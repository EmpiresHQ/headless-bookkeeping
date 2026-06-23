#if os(iOS)
import Photos

/// Registers as a PhotoKit change observer and fires a scan when the library
/// changes while the app is foregrounded. Device-wired; not unit-tested.
public final class PhotoLibraryObserver: NSObject, PHPhotoLibraryChangeObserver {
    private let onChange: @Sendable () -> Void

    public init(onChange: @escaping @Sendable () -> Void) {
        self.onChange = onChange
        super.init()
    }

    public func register() {
        PHPhotoLibrary.shared().register(self)
    }

    public func unregister() {
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }

    public func photoLibraryDidChange(_ changeInstance: PHChange) {
        onChange()
    }
}
#endif
