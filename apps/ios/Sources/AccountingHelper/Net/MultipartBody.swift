import Foundation

public struct MultipartBody {
    private let boundary: String
    private var data = Data()

    public init(boundary: String) { self.boundary = boundary }

    public mutating func addField(name: String, value: String) {
        data.appendString("--\(boundary)\r\n")
        data.appendString("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
        data.appendString("\(value)\r\n")
    }

    public mutating func addFile(name: String, filename: String, contentType: String, data fileData: Data) {
        data.appendString("--\(boundary)\r\n")
        data.appendString("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n")
        data.appendString("Content-Type: \(contentType)\r\n\r\n")
        data.append(fileData)
        data.appendString("\r\n")
    }

    public func finished() -> (contentType: String, body: Data) {
        var body = data
        body.appendString("--\(boundary)--\r\n")
        return ("multipart/form-data; boundary=\(boundary)", body)
    }
}

private extension Data {
    mutating func appendString(_ string: String) { append(Data(string.utf8)) }
}
