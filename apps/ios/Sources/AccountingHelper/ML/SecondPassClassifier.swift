import CoreGraphics

/// Optional on-device "second pass" after the cheap Vision text gate.
///
/// The Vision gate (``VisionGate``) only measures text density, so it cannot tell a
/// receipt apart from a weather screen, a chat log, or a web page — all of which are
/// text-heavy. This classifier looks at the actual image content with a small
/// vision-language model and answers the single question: is this an accounting
/// document (receipt / invoice / bill / payment slip / financial document)?
///
/// - Returns `true`  → it IS an accounting document (proceed to upload candidate).
/// - Returns `false` → it is NOT (record `.ignored`, never upload).
/// - Returns `nil`   → could not decide (model not downloaded / loading / failed).
///   Callers should treat `nil` as a PASS to preserve recall — the second pass is a
///   precision filter, not a hard gate, so an unavailable model must never silently
///   suppress real documents.
///
/// The protocol itself is pure cross-platform Swift (CoreGraphics only) so it compiles
/// in the macOS host (`swift test`) build; the MLX-backed implementation lives in a
/// `#if os(iOS)` file and is only linked into the iOS app target.
public protocol SecondPassClassifier: Sendable {
    func isAccountingDocument(_ image: CGImage) async -> Bool?
}
