import Foundation

public struct PhotoAsset: Equatable, Sendable {
    public let localId: String
    public let capturedAt: Date
    /// True for screenshots (PHAsset `.photoScreenshot`). Used to skip them unless
    /// the user opts in — screenshots (weather, chats, web) are the biggest source
    /// of text-gate false positives.
    public let isScreenshot: Bool
    public init(localId: String, capturedAt: Date, isScreenshot: Bool = false) {
        self.localId = localId; self.capturedAt = capturedAt
        self.isScreenshot = isScreenshot
    }
}

public struct PhotoData: Sendable {
    public let bytes: Data
    public let utiType: String
    public let filename: String
    public init(bytes: Data, utiType: String, filename: String) {
        self.bytes = bytes; self.utiType = utiType; self.filename = filename
    }
}

public enum PhotoAuthStatus: Sendable { case authorized, limited, denied, notDetermined }
