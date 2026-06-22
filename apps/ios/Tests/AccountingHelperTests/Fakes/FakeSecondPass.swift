@testable import AccountingHelper
import CoreGraphics

/// Programmable ``SecondPassClassifier`` for tests.
///
/// `verdict` is the value returned by every call:
/// - `true`  → image IS an accounting document
/// - `false` → image is NOT
/// - `nil`   → undecided / model unavailable (callers treat as a pass)
///
/// `callCount` records how many times the second pass was invoked, so tests can
/// assert it ran only after the cheap gate passed.
final class FakeSecondPass: SecondPassClassifier, @unchecked Sendable {
    var verdict: Bool?
    private(set) var callCount = 0

    init(verdict: Bool?) { self.verdict = verdict }

    func isAccountingDocument(_ image: CGImage) async -> Bool? {
        callCount += 1
        return verdict
    }
}
