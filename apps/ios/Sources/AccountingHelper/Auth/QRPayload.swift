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
        // HTTPS is always accepted. Plain HTTP is accepted ONLY for local-network
        // hosts (loopback / .local / RFC-1918 private IPs) so a self-hosted dev
        // server reachable at e.g. http://192.168.x.x:3001 works, while public
        // cleartext endpoints stay rejected. Pairs with the app's ATS
        // NSAllowsLocalNetworking exception.
        guard let url = URL(string: apiString),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || (scheme == "http" && QRPayload.isLocalHost(url.host))
        else {
            throw QRPayloadError.invalidAPIURL(apiString)
        }
        return QRPayload(api: url, enroll: enroll)
    }

    /// True for loopback, `*.local`, and RFC-1918 private IPv4 hosts.
    static func isLocalHost(_ host: String?) -> Bool {
        guard let host, !host.isEmpty else { return false }
        if host == "localhost" || host == "127.0.0.1" || host == "::1" { return true }
        if host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else {
            return false
        }
        if octets[0] == 10 { return true }
        if octets[0] == 192 && octets[1] == 168 { return true }
        if octets[0] == 172 && (16...31).contains(octets[1]) { return true }
        return false
    }
}
