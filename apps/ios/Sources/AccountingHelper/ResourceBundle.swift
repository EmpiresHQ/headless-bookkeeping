import Foundation

/// Resolves the bundle that holds the app's resources (label embeddings, model
/// manifest) in BOTH build contexts:
/// - SwiftPM (`swift test` / the library target): `SWIFT_PACKAGE` is defined and
///   resources live in the SPM-synthesized `Bundle.module`.
/// - The Xcode app target (XcodeGen): sources are compiled directly into the app,
///   so `Bundle.module` does not exist and resources sit in `Bundle.main`.
enum ResourceBundle {
    static var current: Bundle {
        #if SWIFT_PACKAGE
        return .module
        #else
        return .main
        #endif
    }
}
