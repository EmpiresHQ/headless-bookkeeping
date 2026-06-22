import Foundation

public struct PhotoAsset: Equatable, Sendable {
    public let localId: String
    public let capturedAt: Date
    public init(localId: String, capturedAt: Date) {
        self.localId = localId; self.capturedAt = capturedAt
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
