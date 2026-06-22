import Foundation

public struct QRPayload: Equatable, Sendable {
    public let api: URL
    public let enroll: String
    public init(api: URL, enroll: String) {
        self.api = api
        self.enroll = enroll
    }
}

public enum QRPayloadError: Error, Equatable, Sendable {
    case malformedJSON
    case unsupportedVersion(Int)
    case missingField(String)
    case invalidAPIURL(String)
}

extension QRPayload {
    public static func parse(_ raw: String) throws -> QRPayload {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw QRPayloadError.malformedJSON }

        let version = obj["v"] as? Int ?? -1
        guard version == 1 else { throw QRPayloadError.unsupportedVersion(version) }

        guard let apiString = obj["api"] as? String else {
            throw QRPayloadError.missingField("api")
        }
        guard let enroll = obj["enroll"] as? String, !enroll.isEmpty else {
            throw QRPayloadError.missingField("enroll")
        }
        guard let url = URL(string: apiString), url.scheme == "https" else {
            throw QRPayloadError.invalidAPIURL(apiString)
        }
        return QRPayload(api: url, enroll: enroll)
    }
}
