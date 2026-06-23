import Testing
import Foundation
@testable import AccountingHelper

@Suite struct MultipartBodyTests {
    @Test func buildsMultipartWithFieldAndFile() {
        var body = MultipartBody(boundary: "BOUND")
        body.addField(name: "channel", value: "ios_photo_library")
        body.addFile(name: "file", filename: "A1.HEIC", contentType: "image/heic", data: Data([0x01, 0x02]))
        let (contentType, data) = body.finished()
        let text = String(data: data, encoding: .isoLatin1)!
        #expect(contentType == "multipart/form-data; boundary=BOUND")
        #expect(text.contains("name=\"channel\""))
        #expect(text.contains("ios_photo_library"))
        #expect(text.contains("filename=\"A1.HEIC\""))
        #expect(text.contains("Content-Type: image/heic"))
        #expect(text.hasSuffix("--BOUND--\r\n"))
    }
}
