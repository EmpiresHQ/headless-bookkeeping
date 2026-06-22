import Testing
import Foundation
@testable import AccountingHelper

@Suite struct QRPayloadTests {
    @Test func parsesValidPayload() throws {
        let raw = #"{"v":1,"api":"https://api.example.test","enroll":"abc123"}"#
        let p = try QRPayload.parse(raw)
        #expect(p.api == URL(string: "https://api.example.test")!)
        #expect(p.enroll == "abc123")
    }

    @Test func rejectsUnsupportedVersion() {
        let raw = #"{"v":2,"api":"https://x.test","enroll":"a"}"#
        #expect(throws: QRPayloadError.unsupportedVersion(2)) {
            try QRPayload.parse(raw)
        }
    }

    @Test func rejectsMissingEnroll() {
        let raw = #"{"v":1,"api":"https://x.test"}"#
        #expect(throws: QRPayloadError.missingField("enroll")) {
            try QRPayload.parse(raw)
        }
    }

    @Test func rejectsMalformedJSON() {
        #expect(throws: QRPayloadError.malformedJSON) {
            try QRPayload.parse("not json")
        }
    }

    @Test func rejectsNonHTTPSURL() {
        let raw = #"{"v":1,"api":"ftp://x.test","enroll":"a"}"#
        #expect(throws: QRPayloadError.invalidAPIURL("ftp://x.test")) {
            try QRPayload.parse(raw)
        }
    }
}
