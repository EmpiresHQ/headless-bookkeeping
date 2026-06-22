# iOS Accounting Helper MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native iOS app that enrolls against a self-hosted headless-bookkeeping instance via a scanned QR code, scans the photo library on launch/foreground, runs a layered on-device pre-check (Apple Vision gate → MobileCLIP-S0 zero-shot), and auto-uploads likely financial documents (HEIC originals) to the ERP intake API.

**Architecture:** SwiftUI app in `apps/ios` of the monorepo. Protocol-based dependency injection throughout (`APIClient`, `KeychainStore`, `PhotoSource`, `ModelRunner`, `ScanStateStore`) so the business logic is unit-testable on the host without a real photo library, Keychain, or Core ML weights. Auth issues an eternal session token stored in Keychain. Local scan state lives in SQLite (GRDB). A `ScanCoordinator` orchestrates enumerate → gate → classify → upload → record. Four SwiftUI screens consume observable view models.

**Tech Stack:** Swift 6 / SwiftUI, iOS 18+ deployment target, XCTest, GRDB (SPM), AVFoundation (QR scan), PhotoKit, Vision, CoreML, URLSession. SPM-only; no Alamofire or other heavy third-party deps.

## Global Constraints

- **Deployment target: iOS 18.0.** Use modern PhotoKit / Vision / CoreML APIs; no pre-18 fallbacks.
- **SPM-only dependencies.** The only third-party package is **GRDB** (SQLite). Everything else is system framework (URLSession, Vision, CoreML, PhotoKit, AVFoundation, Security/Keychain).
- **No Alamofire / Moya / networking wrappers.** `URLSession` only.
- **Secrets in Keychain only.** The session token MUST be stored via the Security framework, never `UserDefaults`.
- **Single-tenant.** No `tenantId`/`userId`/`refreshToken` anywhere. Session token is eternal; there is no refresh flow.
- **QR payload shape is exactly** `{ "v": 1, "api": string, "enroll": string }`.
- **All authed API calls** send `Authorization: Bearer <sessionToken>`.
- **All dependencies are injected behind protocols.** Production types conform; tests use fakes. No singletons reached directly from business logic.
- **Model weights are never committed.** `apps/ios/Models/` is gitignored; only the manifest (`url`+`sha256`+`version`), the download script, and the precomputed label-embeddings JSON live in the repo.
- **Tests that need a simulator are marked** with a `// SIMULATOR-ONLY` comment and isolated in a separate test target/file; pure-logic units must run without a device.
- **Upstream dependencies (do NOT re-implement here):**
  - Enrollment endpoints `POST /api/device-enrollments`, `POST /api/mobile/sessions` (body `{deviceName}` → `{accessToken}`), `POST /api/mobile/sessions/revoke` — specced in the QR enrollment plan (`docs/superpowers/plans/2026-06-22-qr-enrollment-token-auth.md`).
  - Extended `POST /api/documents` accepting multipart `channel`/`assetLocalId`/`capturedAt`/`precheck` — specced in the sibling backend plan `docs/superpowers/plans/2026-06-22-ios-upload-api-extension.md`.

## File Structure

```
apps/ios/
  Package.swift                         # SPM manifest (GRDB dep, app + test targets)
  .gitignore                            # ignores Models/
  Models/                               # (gitignored) downloaded MobileCLIP-S0.mlpackage
  Resources/
    label-embeddings.json              # precomputed text embeddings + label metadata
    model-manifest.json                # { url, sha256, version }
  Scripts/
    fetch-model.sh                     # downloads + checksums the .mlpackage
  Sources/AccountingHelper/
    App.swift                          # @main entry, scene wiring
    Auth/
      QRPayload.swift                  # parse/validate {v,api,enroll}
      KeychainStore.swift             # protocol + Security-backed impl
      AuthService.swift               # enroll-exchange + logout
    Net/
      APIClient.swift                 # protocol + URLSession impl
      MultipartBody.swift             # multipart/form-data builder
    State/
      ScanStateStore.swift            # protocol + GRDB impl (cursor/uploaded/ignored)
      AppSettings.swift               # threshold, autoUpload (UserDefaults-backed)
    Photos/
      PhotoSource.swift               # protocol + PhotoKit impl + change observer
      PhotoAsset.swift                # plain value type (localId, capturedAt, fetch bytes)
    ML/
      ModelRunner.swift               # protocol: gate + classify
      VisionGate.swift                # Apple Vision cheap pre-filter
      MobileCLIPRunner.swift          # CoreML zero-shot
      LabelSet.swift                  # labels + financial/non-financial split + embeddings load
      PrecheckDecision.swift          # decision rule (max-fin vs max-nonfin + threshold)
    Scan/
      ScanCoordinator.swift           # orchestration: enumerate→gate→classify→upload→record
    Upload/
      DocumentUploader.swift          # builds + sends the multipart upload
    UI/
      LoginView.swift / LoginViewModel.swift
      QRScannerView.swift             # AVFoundation wrapper (UIViewControllerRepresentable)
      HomeView.swift / HomeViewModel.swift
      LogView.swift / LogViewModel.swift
      SettingsView.swift / SettingsViewModel.swift
  Tests/AccountingHelperTests/
    QRPayloadTests.swift
    AuthServiceTests.swift
    KeychainStoreTests.swift          # SIMULATOR-ONLY
    APIClientTests.swift
    MultipartBodyTests.swift
    ScanStateStoreTests.swift
    PrecheckDecisionTests.swift
    LabelSetTests.swift
    ScanCoordinatorTests.swift
    DocumentUploaderTests.swift
    Fakes/                            # FakeAPIClient, FakeKeychain, FakePhotoSource, FakeModelRunner, FakeScanStateStore
```

---

### Task 1: SPM package skeleton + CI build

**Files:**
- Create: `apps/ios/Package.swift`
- Create: `apps/ios/.gitignore`
- Create: `apps/ios/Sources/AccountingHelper/Net/APIClient.swift` (placeholder type so the target compiles)
- Test: `apps/ios/Tests/AccountingHelperTests/SmokeTests.swift`

**Interfaces:**
- Produces: a buildable SPM package named `AccountingHelper` with a library target `AccountingHelper` and a test target `AccountingHelperTests`, depending on GRDB. (UI lives in the same library; the `.app` is wired in Xcode later — the library is what we unit-test.)

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/SmokeTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class SmokeTests: XCTestCase {
    func testLibraryLinks() {
        // Compiles + links the library and GRDB. The marker proves the
        // module is importable before any real type exists.
        XCTAssertEqual(AccountingHelperModuleMarker.ok, true)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test`
Expected: FAIL — no `Package.swift` / `AccountingHelperModuleMarker` undefined.

- [ ] **Step 3: Create the package manifest**

Create `apps/ios/Package.swift`:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AccountingHelper",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "AccountingHelper", targets: ["AccountingHelper"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
    ],
    targets: [
        .target(
            name: "AccountingHelper",
            dependencies: [.product(name: "GRDB", package: "GRDB.swift")],
            resources: [.process("../../Resources")]
        ),
        .testTarget(
            name: "AccountingHelperTests",
            dependencies: ["AccountingHelper"]
        ),
    ]
)
```

> **Why GRDB over the raw SQLite3 C API:** GRDB gives a typed, migration-aware, value-type record API with a synchronous `DatabaseQueue` that is trivial to point at an in-memory database in tests. The raw C API would force manual statement lifecycle and pointer juggling in every test. GRDB is a single SPM dependency with no transitive bloat — acceptable under the SPM-only constraint.

- [ ] **Step 4: Create the module marker + gitignore**

Create `apps/ios/Sources/AccountingHelper/Net/APIClient.swift`:

```swift
import Foundation

/// Compile-time marker proving the module links. Removed once real types exist.
public enum AccountingHelperModuleMarker {
    public static let ok = true
}
```

Create `apps/ios/.gitignore`:

```
Models/
.build/
*.xcodeproj
*.xcworkspace
xcuserdata/
DerivedData/
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/ios && swift test`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add apps/ios/Package.swift apps/ios/.gitignore apps/ios/Sources/AccountingHelper/Net/APIClient.swift apps/ios/Tests/AccountingHelperTests/SmokeTests.swift
git commit -m "feat(ios): SPM package skeleton with GRDB + smoke test"
```

---

### Task 2: QR payload parsing + validation

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/Auth/QRPayload.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/QRPayloadTests.swift`

**Interfaces:**
- Produces:
  - `struct QRPayload: Equatable { let api: URL; let enroll: String }`
  - `enum QRPayloadError: Error, Equatable { case malformedJSON, unsupportedVersion(Int), missingField(String), invalidAPIURL(String) }`
  - `static func QRPayload.parse(_ raw: String) throws -> QRPayload`

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/QRPayloadTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class QRPayloadTests: XCTestCase {
    func testParsesValidPayload() throws {
        let raw = #"{"v":1,"api":"https://api.example.test","enroll":"abc123"}"#
        let p = try QRPayload.parse(raw)
        XCTAssertEqual(p.api, URL(string: "https://api.example.test")!)
        XCTAssertEqual(p.enroll, "abc123")
    }

    func testRejectsUnsupportedVersion() {
        let raw = #"{"v":2,"api":"https://x.test","enroll":"a"}"#
        XCTAssertThrowsError(try QRPayload.parse(raw)) { err in
            XCTAssertEqual(err as? QRPayloadError, .unsupportedVersion(2))
        }
    }

    func testRejectsMissingEnroll() {
        let raw = #"{"v":1,"api":"https://x.test"}"#
        XCTAssertThrowsError(try QRPayload.parse(raw)) { err in
            XCTAssertEqual(err as? QRPayloadError, .missingField("enroll"))
        }
    }

    func testRejectsMalformedJSON() {
        XCTAssertThrowsError(try QRPayload.parse("not json")) { err in
            XCTAssertEqual(err as? QRPayloadError, .malformedJSON)
        }
    }

    func testRejectsNonHTTPSURL() {
        let raw = #"{"v":1,"api":"ftp://x.test","enroll":"a"}"#
        XCTAssertThrowsError(try QRPayload.parse(raw)) { err in
            XCTAssertEqual(err as? QRPayloadError, .invalidAPIURL("ftp://x.test"))
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter QRPayloadTests`
Expected: FAIL — `QRPayload` undefined.

- [ ] **Step 3: Implement QRPayload**

Create `apps/ios/Sources/AccountingHelper/Auth/QRPayload.swift`:

```swift
import Foundation

public struct QRPayload: Equatable, Sendable {
    public let api: URL
    public let enroll: String
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter QRPayloadTests`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/Auth/QRPayload.swift apps/ios/Tests/AccountingHelperTests/QRPayloadTests.swift
git commit -m "feat(ios): QR payload parse + validation"
```

---

### Task 3: Keychain store (protocol + fake + real impl)

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/Auth/KeychainStore.swift`
- Create: `apps/ios/Tests/AccountingHelperTests/Fakes/FakeKeychain.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/KeychainStoreTests.swift` (SIMULATOR-ONLY)

**Interfaces:**
- Produces:
  - `protocol KeychainStore: Sendable { func save(token: String) throws; func read() throws -> String?; func delete() throws }`
  - `final class SystemKeychainStore: KeychainStore` (Security framework, service `"finance.verifi.accountinghelper.session"`)
  - `final class FakeKeychain: KeychainStore` (in-memory, for all non-Keychain tests)

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/KeychainStoreTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

// SIMULATOR-ONLY: exercises the real Security framework keychain.
final class KeychainStoreTests: XCTestCase {
    func testSaveReadDeleteRoundTrip() throws {
        let store = SystemKeychainStore(service: "test.accountinghelper.\(UUID().uuidString)")
        XCTAssertNil(try store.read())
        try store.save(token: "tok-1")
        XCTAssertEqual(try store.read(), "tok-1")
        try store.save(token: "tok-2") // overwrite
        XCTAssertEqual(try store.read(), "tok-2")
        try store.delete()
        XCTAssertNil(try store.read())
    }
}
```

Also create `apps/ios/Tests/AccountingHelperTests/Fakes/FakeKeychain.swift`:

```swift
@testable import AccountingHelper

final class FakeKeychain: KeychainStore, @unchecked Sendable {
    private var stored: String?
    var saveError: Error?
    func save(token: String) throws { if let saveError { throw saveError }; stored = token }
    func read() throws -> String? { stored }
    func delete() throws { stored = nil }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter KeychainStoreTests`
Expected: FAIL — `KeychainStore`/`SystemKeychainStore` undefined.

- [ ] **Step 3: Implement the protocol + Security-backed store**

Create `apps/ios/Sources/AccountingHelper/Auth/KeychainStore.swift`:

```swift
import Foundation
import Security

public protocol KeychainStore: Sendable {
    func save(token: String) throws
    func read() throws -> String?
    func delete() throws
}

public enum KeychainError: Error { case unexpectedStatus(OSStatus) }

public final class SystemKeychainStore: KeychainStore {
    private let service: String
    private let account = "session"

    public init(service: String = "finance.verifi.accountinghelper.session") {
        self.service = service
    }

    private func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func save(token: String) throws {
        try delete()
        var q = baseQuery()
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
    }

    public func read() throws -> String? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw KeychainError.unexpectedStatus(status)
        }
        return String(data: data, encoding: .utf8)
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter KeychainStoreTests` (on a simulator destination; the round-trip needs the real keychain).
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/Auth/KeychainStore.swift apps/ios/Tests/AccountingHelperTests/KeychainStoreTests.swift apps/ios/Tests/AccountingHelperTests/Fakes/FakeKeychain.swift
git commit -m "feat(ios): KeychainStore protocol + Security-backed impl + fake"
```

---

### Task 4: APIClient protocol + URLSession impl

**Files:**
- Modify: `apps/ios/Sources/AccountingHelper/Net/APIClient.swift` (replace the marker)
- Create: `apps/ios/Tests/AccountingHelperTests/Fakes/FakeAPIClient.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/APIClientTests.swift`

**Interfaces:**
- Produces:
  - `struct APIRequest { var method: String; var path: String; var body: Data?; var contentType: String?; var bearer: String? }`
  - `struct APIResponse { let status: Int; let data: Data }`
  - `protocol APIClient: Sendable { func send(_ req: APIRequest) async throws -> APIResponse }`
  - `final class URLSessionAPIClient: APIClient` — init `(baseURL: URL, session: URLSession = .shared)`; prefixes `path` onto `baseURL`, sets `Authorization`/`Content-Type` headers.
  - `final class FakeAPIClient: APIClient` — records sent requests, returns a queued response or throws.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/APIClientTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class APIClientTests: XCTestCase {
    func testBuildsAuthorizedRequest() async throws {
        URLProtocolStub.responder = { req in
            XCTAssertEqual(req.url?.absoluteString, "https://api.test/api/ping")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sess-1")
            let resp = HTTPURLResponse(url: req.url!, statusCode: 204, httpVersion: nil, headerFields: nil)!
            return (resp, Data())
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        let client = URLSessionAPIClient(baseURL: URL(string: "https://api.test")!,
                                         session: URLSession(configuration: config))
        let resp = try await client.send(APIRequest(method: "GET", path: "/api/ping", bearer: "sess-1"))
        XCTAssertEqual(resp.status, 204)
    }
}
```

Add `apps/ios/Tests/AccountingHelperTests/URLProtocolStub.swift`:

```swift
import Foundation

final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var responder: ((URLRequest) -> (HTTPURLResponse, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let responder = Self.responder else { return }
        let (resp, data) = responder(request)
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
```

And the fake `apps/ios/Tests/AccountingHelperTests/Fakes/FakeAPIClient.swift`:

```swift
@testable import AccountingHelper
import Foundation

final class FakeAPIClient: APIClient, @unchecked Sendable {
    private(set) var sent: [APIRequest] = []
    var responses: [Result<APIResponse, Error>] = []
    func send(_ req: APIRequest) async throws -> APIResponse {
        sent.append(req)
        guard !responses.isEmpty else { return APIResponse(status: 200, data: Data()) }
        switch responses.removeFirst() {
        case .success(let r): return r
        case .failure(let e): throw e
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter APIClientTests`
Expected: FAIL — `APIRequest`/`URLSessionAPIClient` undefined (marker still present).

- [ ] **Step 3: Implement APIClient**

Replace the contents of `apps/ios/Sources/AccountingHelper/Net/APIClient.swift`:

```swift
import Foundation

public struct APIRequest: Sendable {
    public var method: String
    public var path: String
    public var body: Data?
    public var contentType: String?
    public var bearer: String?
    public init(method: String, path: String, body: Data? = nil,
                contentType: String? = nil, bearer: String? = nil) {
        self.method = method; self.path = path; self.body = body
        self.contentType = contentType; self.bearer = bearer
    }
}

public struct APIResponse: Sendable {
    public let status: Int
    public let data: Data
}

public protocol APIClient: Sendable {
    func send(_ req: APIRequest) async throws -> APIResponse
}

public final class URLSessionAPIClient: APIClient {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    public func send(_ req: APIRequest) async throws -> APIResponse {
        let url = URL(string: req.path, relativeTo: baseURL) ?? baseURL.appendingPathComponent(req.path)
        var urlReq = URLRequest(url: url.absoluteURL)
        urlReq.httpMethod = req.method
        urlReq.httpBody = req.body
        if let ct = req.contentType { urlReq.setValue(ct, forHTTPHeaderField: "Content-Type") }
        if let bearer = req.bearer { urlReq.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await session.data(for: urlReq)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        return APIResponse(status: status, data: data)
    }
}
```

> Note: `URL(string:relativeTo:)` keeps the `https://api.test` host and appends `/api/ping`. The base URL must NOT have a trailing path component for this to resolve cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter APIClientTests`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/Net/APIClient.swift apps/ios/Tests/AccountingHelperTests/APIClientTests.swift apps/ios/Tests/AccountingHelperTests/URLProtocolStub.swift apps/ios/Tests/AccountingHelperTests/Fakes/FakeAPIClient.swift
git commit -m "feat(ios): APIClient protocol + URLSession impl + fakes"
```

---

### Task 5: AuthService — enroll exchange + logout

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/Auth/AuthService.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/AuthServiceTests.swift`

**Interfaces:**
- Consumes: `APIClient` (Task 4), `KeychainStore` (Task 3), `QRPayload` (Task 2).
- Produces:
  - `enum AuthError: Error, Equatable { case exchangeFailed(Int); case noStoredSession }`
  - `final class AuthService` with init `(apiFor: @escaping (URL) -> APIClient, keychain: KeychainStore)`.
  - `func enroll(payload: QRPayload, deviceName: String) async throws -> String` — POST `/api/mobile/sessions` with `Bearer payload.enroll` + body `{"deviceName":...}`; on 200/201 stores `accessToken` in Keychain and persists the base URL; returns the token.
  - `func currentToken() throws -> String?` — reads Keychain.
  - `func logout(baseURL: URL) async` — POST `/api/mobile/sessions/revoke` with the session bearer (best-effort), then always clears Keychain.

> The `apiFor` closure lets `AuthService` build a client bound to the scanned base URL (unknown until scan time) while staying injectable in tests.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/AuthServiceTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class AuthServiceTests: XCTestCase {
    func testEnrollStoresSessionToken() async throws {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 201,
            data: #"{"accessToken":"sess-xyz"}"#.data(using: .utf8)!))]
        let keychain = FakeKeychain()
        let svc = AuthService(apiFor: { _ in api }, keychain: keychain)
        let payload = QRPayload(api: URL(string: "https://api.test")!, enroll: "enr-1")

        let token = try await svc.enroll(payload: payload, deviceName: "iPhone QA")

        XCTAssertEqual(token, "sess-xyz")
        XCTAssertEqual(try keychain.read(), "sess-xyz")
        let sent = api.sent.first!
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/mobile/sessions")
        XCTAssertEqual(sent.bearer, "enr-1")
        XCTAssertTrue(String(data: sent.body!, encoding: .utf8)!.contains("iPhone QA"))
    }

    func testEnrollThrowsOnNon2xx() async {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 401, data: Data()))]
        let keychain = FakeKeychain()
        let svc = AuthService(apiFor: { _ in api }, keychain: keychain)
        let payload = QRPayload(api: URL(string: "https://api.test")!, enroll: "bad")
        do {
            _ = try await svc.enroll(payload: payload, deviceName: "x")
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(error as? AuthError, .exchangeFailed(401))
            XCTAssertNil(try? keychain.read())
        }
    }

    func testLogoutRevokesThenClearsKeychain() async throws {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 204, data: Data()))]
        let keychain = FakeKeychain()
        try keychain.save(token: "sess-old")
        let svc = AuthService(apiFor: { _ in api }, keychain: keychain)

        await svc.logout(baseURL: URL(string: "https://api.test")!)

        XCTAssertEqual(api.sent.first?.path, "/api/mobile/sessions/revoke")
        XCTAssertEqual(api.sent.first?.bearer, "sess-old")
        XCTAssertNil(try keychain.read())
    }

    func testLogoutClearsKeychainEvenIfRevokeFails() async throws {
        let api = FakeAPIClient()
        api.responses = [.failure(URLError(.notConnectedToInternet))]
        let keychain = FakeKeychain()
        try keychain.save(token: "sess-old")
        let svc = AuthService(apiFor: { _ in api }, keychain: keychain)

        await svc.logout(baseURL: URL(string: "https://api.test")!)

        XCTAssertNil(try keychain.read())
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter AuthServiceTests`
Expected: FAIL — `AuthService` undefined.

- [ ] **Step 3: Implement AuthService**

Create `apps/ios/Sources/AccountingHelper/Auth/AuthService.swift`:

```swift
import Foundation

public enum AuthError: Error, Equatable {
    case exchangeFailed(Int)
    case noStoredSession
}

public final class AuthService {
    private let apiFor: (URL) -> APIClient
    private let keychain: KeychainStore

    public init(apiFor: @escaping (URL) -> APIClient, keychain: KeychainStore) {
        self.apiFor = apiFor
        self.keychain = keychain
    }

    public func enroll(payload: QRPayload, deviceName: String) async throws -> String {
        let body = try JSONSerialization.data(withJSONObject: ["deviceName": deviceName])
        let resp = try await apiFor(payload.api).send(APIRequest(
            method: "POST", path: "/api/mobile/sessions",
            body: body, contentType: "application/json", bearer: payload.enroll))
        guard (200...299).contains(resp.status) else {
            throw AuthError.exchangeFailed(resp.status)
        }
        let parsed = try JSONSerialization.jsonObject(with: resp.data) as? [String: Any]
        guard let token = parsed?["accessToken"] as? String else {
            throw AuthError.exchangeFailed(resp.status)
        }
        try keychain.save(token: token)
        return token
    }

    public func currentToken() throws -> String? {
        try keychain.read()
    }

    public func logout(baseURL: URL) async {
        if let token = try? keychain.read() {
            _ = try? await apiFor(baseURL).send(APIRequest(
                method: "POST", path: "/api/mobile/sessions/revoke", bearer: token))
        }
        try? keychain.delete()
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter AuthServiceTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/Auth/AuthService.swift apps/ios/Tests/AccountingHelperTests/AuthServiceTests.swift
git commit -m "feat(ios): AuthService enroll exchange + best-effort logout"
```

---

### Task 6: ScanStateStore — GRDB cursor + uploaded/ignored sets

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/State/ScanStateStore.swift`
- Create: `apps/ios/Tests/AccountingHelperTests/Fakes/FakeScanStateStore.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/ScanStateStoreTests.swift`

**Interfaces:**
- Produces:
  - `enum AssetOutcome: String, Codable, Sendable { case uploaded, ignored }`
  - `struct LogEntry: Equatable, Sendable { let assetLocalId: String; let outcome: AssetOutcome; let topLabel: String; let score: Double; let at: Date }`
  - `protocol ScanStateStore: Sendable { func status(of id: String) throws -> AssetOutcome?; func record(_ entry: LogEntry) throws; func recentLog(limit: Int) throws -> [LogEntry]; func counts() throws -> (uploaded: Int, ignored: Int); func reset() throws }`
  - `final class GRDBScanStateStore: ScanStateStore` — init `(path: String)` (use `":memory:"`-equivalent `DatabaseQueue()` in tests).
  - `final class FakeScanStateStore: ScanStateStore` (in-memory dictionary).

> "Cursor" is implicit: an asset is "already handled" iff `status(of:)` is non-nil. Enumeration filters out handled assets; failed uploads are simply never recorded, so they reappear next scan (retry). No separate cursor row is needed.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/ScanStateStoreTests.swift`:

```swift
import XCTest
import GRDB
@testable import AccountingHelper

final class ScanStateStoreTests: XCTestCase {
    private func makeStore() throws -> GRDBScanStateStore {
        try GRDBScanStateStore(queue: DatabaseQueue()) // in-memory
    }

    func testRecordsAndReadsStatus() throws {
        let store = try makeStore()
        XCTAssertNil(try store.status(of: "A1"))
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded,
                                  topLabel: "purchase_receipt", score: 0.9,
                                  at: Date(timeIntervalSince1970: 100)))
        XCTAssertEqual(try store.status(of: "A1"), .uploaded)
    }

    func testCounts() throws {
        let store = try makeStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        try store.record(LogEntry(assetLocalId: "A2", outcome: .ignored, topLabel: "selfie", score: 0.1, at: Date()))
        try store.record(LogEntry(assetLocalId: "A3", outcome: .uploaded, topLabel: "r", score: 0.8, at: Date()))
        let c = try store.counts()
        XCTAssertEqual(c.uploaded, 2)
        XCTAssertEqual(c.ignored, 1)
    }

    func testRecentLogIsNewestFirst() throws {
        let store = try makeStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date(timeIntervalSince1970: 1)))
        try store.record(LogEntry(assetLocalId: "A2", outcome: .ignored, topLabel: "s", score: 0.1, at: Date(timeIntervalSince1970: 2)))
        let log = try store.recentLog(limit: 10)
        XCTAssertEqual(log.map(\.assetLocalId), ["A2", "A1"])
    }

    func testResetClearsEverything() throws {
        let store = try makeStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        try store.reset()
        XCTAssertNil(try store.status(of: "A1"))
        XCTAssertEqual(try store.counts().uploaded, 0)
    }

    func testIdempotentRecordKeepsSingleRow() throws {
        let store = try makeStore()
        let e = LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date())
        try store.record(e)
        try store.record(e) // same id again — must not double count
        XCTAssertEqual(try store.counts().uploaded, 1)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter ScanStateStoreTests`
Expected: FAIL — `GRDBScanStateStore` undefined.

- [ ] **Step 3: Implement the store**

Create `apps/ios/Sources/AccountingHelper/State/ScanStateStore.swift`:

```swift
import Foundation
import GRDB

public enum AssetOutcome: String, Codable, Sendable { case uploaded, ignored }

public struct LogEntry: Equatable, Sendable {
    public let assetLocalId: String
    public let outcome: AssetOutcome
    public let topLabel: String
    public let score: Double
    public let at: Date
    public init(assetLocalId: String, outcome: AssetOutcome, topLabel: String, score: Double, at: Date) {
        self.assetLocalId = assetLocalId; self.outcome = outcome
        self.topLabel = topLabel; self.score = score; self.at = at
    }
}

public protocol ScanStateStore: Sendable {
    func status(of id: String) throws -> AssetOutcome?
    func record(_ entry: LogEntry) throws
    func recentLog(limit: Int) throws -> [LogEntry]
    func counts() throws -> (uploaded: Int, ignored: Int)
    func reset() throws
}

public final class GRDBScanStateStore: ScanStateStore {
    private let queue: DatabaseQueue

    public init(queue: DatabaseQueue) throws {
        self.queue = queue
        try migrate()
    }

    public convenience init(path: String) throws {
        try self.init(queue: try DatabaseQueue(path: path))
    }

    private func migrate() throws {
        try queue.write { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS asset_state (
                    asset_local_id TEXT PRIMARY KEY,
                    outcome TEXT NOT NULL,
                    top_label TEXT NOT NULL,
                    score DOUBLE NOT NULL,
                    at DOUBLE NOT NULL
                )
            """)
        }
    }

    public func status(of id: String) throws -> AssetOutcome? {
        try queue.read { db in
            guard let raw = try String.fetchOne(db,
                sql: "SELECT outcome FROM asset_state WHERE asset_local_id = ?", arguments: [id])
            else { return nil }
            return AssetOutcome(rawValue: raw)
        }
    }

    public func record(_ entry: LogEntry) throws {
        try queue.write { db in
            try db.execute(sql: """
                INSERT INTO asset_state (asset_local_id, outcome, top_label, score, at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(asset_local_id) DO UPDATE SET
                    outcome = excluded.outcome, top_label = excluded.top_label,
                    score = excluded.score, at = excluded.at
            """, arguments: [entry.assetLocalId, entry.outcome.rawValue,
                             entry.topLabel, entry.score, entry.at.timeIntervalSince1970])
        }
    }

    public func recentLog(limit: Int) throws -> [LogEntry] {
        try queue.read { db in
            try Row.fetchAll(db,
                sql: "SELECT * FROM asset_state ORDER BY at DESC LIMIT ?", arguments: [limit])
            .map { row in
                LogEntry(assetLocalId: row["asset_local_id"],
                         outcome: AssetOutcome(rawValue: row["outcome"])!,
                         topLabel: row["top_label"], score: row["score"],
                         at: Date(timeIntervalSince1970: row["at"]))
            }
        }
    }

    public func counts() throws -> (uploaded: Int, ignored: Int) {
        try queue.read { db in
            let up = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM asset_state WHERE outcome = 'uploaded'") ?? 0
            let ig = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM asset_state WHERE outcome = 'ignored'") ?? 0
            return (up, ig)
        }
    }

    public func reset() throws {
        try queue.write { db in try db.execute(sql: "DELETE FROM asset_state") }
    }
}
```

Create `apps/ios/Tests/AccountingHelperTests/Fakes/FakeScanStateStore.swift`:

```swift
@testable import AccountingHelper
import Foundation

final class FakeScanStateStore: ScanStateStore, @unchecked Sendable {
    private(set) var entries: [String: LogEntry] = [:]
    func status(of id: String) throws -> AssetOutcome? { entries[id]?.outcome }
    func record(_ entry: LogEntry) throws { entries[entry.assetLocalId] = entry }
    func recentLog(limit: Int) throws -> [LogEntry] {
        Array(entries.values.sorted { $0.at > $1.at }.prefix(limit))
    }
    func counts() throws -> (uploaded: Int, ignored: Int) {
        (entries.values.filter { $0.outcome == .uploaded }.count,
         entries.values.filter { $0.outcome == .ignored }.count)
    }
    func reset() throws { entries.removeAll() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter ScanStateStoreTests`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/State/ScanStateStore.swift apps/ios/Tests/AccountingHelperTests/Fakes/FakeScanStateStore.swift apps/ios/Tests/AccountingHelperTests/ScanStateStoreTests.swift
git commit -m "feat(ios): GRDB scan state store (idempotent by assetLocalId) + fake"
```

---

### Task 7: LabelSet — labels, financial split, embeddings load

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/ML/LabelSet.swift`
- Create: `apps/ios/Resources/label-embeddings.json`
- Test: `apps/ios/Tests/AccountingHelperTests/LabelSetTests.swift`

**Interfaces:**
- Produces:
  - `struct Label: Equatable, Sendable { let name: String; let prompt: String; let isFinancial: Bool; let embedding: [Float] }`
  - `struct LabelSet: Sendable { let labels: [Label]; static func load(from data: Data) throws -> LabelSet; func loadBundled() }` — plus `static func bundled() throws -> LabelSet` reading `label-embeddings.json` from the module bundle.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/LabelSetTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class LabelSetTests: XCTestCase {
    func testLoadsLabelsWithFinancialFlagAndEmbedding() throws {
        let json = """
        {"dim":2,"labels":[
          {"name":"purchase_receipt","prompt":"a photo of a purchase receipt","financial":true,"embedding":[0.1,0.2]},
          {"name":"selfie","prompt":"a selfie","financial":false,"embedding":[0.3,0.4]}
        ]}
        """.data(using: .utf8)!
        let set = try LabelSet.load(from: json)
        XCTAssertEqual(set.labels.count, 2)
        XCTAssertEqual(set.labels[0].name, "purchase_receipt")
        XCTAssertTrue(set.labels[0].isFinancial)
        XCTAssertEqual(set.labels[0].embedding, [0.1, 0.2])
        XCTAssertFalse(set.labels[1].isFinancial)
    }

    func testBundledLabelSetHasFinancialAndNonFinancial() throws {
        let set = try LabelSet.bundled()
        XCTAssertTrue(set.labels.contains { $0.isFinancial })
        XCTAssertTrue(set.labels.contains { !$0.isFinancial })
        // every embedding has the same dimension
        let dims = Set(set.labels.map { $0.embedding.count })
        XCTAssertEqual(dims.count, 1)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter LabelSetTests`
Expected: FAIL — `LabelSet` undefined and resource missing.

- [ ] **Step 3: Create the label-embeddings resource**

Create `apps/ios/Resources/label-embeddings.json`. The `embedding` arrays are placeholders here (`dim` matches MobileCLIP-S0 text-embedding dim = 512) — **Task 12 regenerates this file with real embeddings via the fetch/encode script.** For now, ship zero-vectors of the correct length so the schema and decision logic are testable. (Use a short generator one-liner to emit 512 zeros per label; the committed file is the full JSON.)

Structure (one object per label; financial split per the locked label set):

```json
{
  "model": "mobileclip-s0",
  "dim": 512,
  "labels": [
    { "name": "purchase_receipt", "prompt": "a photo of a purchase receipt", "financial": true, "embedding": [0.0, "...512 floats..."] },
    { "name": "restaurant_bill", "prompt": "a photo of a restaurant bill", "financial": true, "embedding": ["...512 floats..."] },
    { "name": "invoice_document", "prompt": "a photo of an invoice document", "financial": true, "embedding": ["...512 floats..."] },
    { "name": "payment_terminal_slip", "prompt": "a photo of a payment terminal slip", "financial": true, "embedding": ["...512 floats..."] },
    { "name": "receipt_screenshot", "prompt": "a screenshot of a receipt", "financial": true, "embedding": ["...512 floats..."] },
    { "name": "personal_photo", "prompt": "a personal photo", "financial": false, "embedding": ["...512 floats..."] },
    { "name": "food_photo", "prompt": "a food photo", "financial": false, "embedding": ["...512 floats..."] },
    { "name": "selfie", "prompt": "a selfie", "financial": false, "embedding": ["...512 floats..."] },
    { "name": "random_screenshot", "prompt": "a random screenshot", "financial": false, "embedding": ["...512 floats..."] },
    { "name": "not_financial_document", "prompt": "not a financial document", "financial": false, "embedding": ["...512 floats..."] }
  ]
}
```

> Implementation note for the engineer: generate the placeholder file programmatically so each `embedding` is exactly 512 zero floats — do not hand-type 512 numbers. e.g. a Python/Node snippet that writes the JSON. The real vectors land in Task 12.

- [ ] **Step 4: Implement LabelSet**

Create `apps/ios/Sources/AccountingHelper/ML/LabelSet.swift`:

```swift
import Foundation

public struct Label: Equatable, Sendable {
    public let name: String
    public let prompt: String
    public let isFinancial: Bool
    public let embedding: [Float]
}

public struct LabelSet: Sendable {
    public let labels: [Label]

    private struct Wire: Decodable {
        struct L: Decodable { let name: String; let prompt: String; let financial: Bool; let embedding: [Float] }
        let labels: [L]
    }

    public static func load(from data: Data) throws -> LabelSet {
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        return LabelSet(labels: wire.labels.map {
            Label(name: $0.name, prompt: $0.prompt, isFinancial: $0.financial, embedding: $0.embedding)
        })
    }

    public static func bundled() throws -> LabelSet {
        guard let url = Bundle.module.url(forResource: "label-embeddings", withExtension: "json") else {
            throw NSError(domain: "LabelSet", code: 1)
        }
        return try load(from: Data(contentsOf: url))
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter LabelSetTests`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/ML/LabelSet.swift apps/ios/Resources/label-embeddings.json apps/ios/Tests/AccountingHelperTests/LabelSetTests.swift
git commit -m "feat(ios): LabelSet load + bundled label-embeddings resource (placeholder vectors)"
```

---

### Task 8: PrecheckDecision — scoring rule

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/ML/PrecheckDecision.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/PrecheckDecisionTests.swift`

**Interfaces:**
- Consumes: `LabelSet`/`Label` (Task 7).
- Produces:
  - `struct LabelScore: Equatable, Sendable, Codable { let name: String; let score: Double }`
  - `enum PrecheckDecisionKind: String, Codable, Sendable { case upload, ignore }`
  - `struct PrecheckResult: Equatable, Sendable, Codable { let decision: PrecheckDecisionKind; let topLabel: String; let topScore: Double; let scores: [LabelScore] }`
  - `enum PrecheckDecision { static func decide(imageEmbedding: [Float], labels: LabelSet, threshold: Double) -> PrecheckResult }` — cosine-similarity of image vs each label embedding; `upload` iff the best **financial** label beats the best **non-financial** label AND `bestFinancial >= threshold`.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/PrecheckDecisionTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class PrecheckDecisionTests: XCTestCase {
    private func labels() -> LabelSet {
        LabelSet(labels: [
            Label(name: "receipt", prompt: "", isFinancial: true,  embedding: [1, 0]),
            Label(name: "selfie",  prompt: "", isFinancial: false, embedding: [0, 1]),
        ])
    }

    func testUploadsWhenFinancialWinsAboveThreshold() {
        let r = PrecheckDecision.decide(imageEmbedding: [1, 0], labels: labels(), threshold: 0.5)
        XCTAssertEqual(r.decision, .upload)
        XCTAssertEqual(r.topLabel, "receipt")
        XCTAssertEqual(r.topScore, 1.0, accuracy: 1e-6)
    }

    func testIgnoresWhenNonFinancialWins() {
        let r = PrecheckDecision.decide(imageEmbedding: [0, 1], labels: labels(), threshold: 0.5)
        XCTAssertEqual(r.decision, .ignore)
        XCTAssertEqual(r.topLabel, "selfie")
    }

    func testIgnoresWhenFinancialWinsButBelowThreshold() {
        // image leans financial but weakly (cos ~0.45)
        let r = PrecheckDecision.decide(imageEmbedding: [0.45, 0.42], labels: labels(), threshold: 0.6)
        XCTAssertEqual(r.decision, .ignore)
    }

    func testScoresIncludeAllLabels() {
        let r = PrecheckDecision.decide(imageEmbedding: [1, 0], labels: labels(), threshold: 0.5)
        XCTAssertEqual(Set(r.scores.map(\.name)), ["receipt", "selfie"])
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter PrecheckDecisionTests`
Expected: FAIL — `PrecheckDecision` undefined.

- [ ] **Step 3: Implement the decision rule**

Create `apps/ios/Sources/AccountingHelper/ML/PrecheckDecision.swift`:

```swift
import Foundation

public struct LabelScore: Equatable, Sendable, Codable {
    public let name: String
    public let score: Double
}

public enum PrecheckDecisionKind: String, Codable, Sendable { case upload, ignore }

public struct PrecheckResult: Equatable, Sendable, Codable {
    public let decision: PrecheckDecisionKind
    public let topLabel: String
    public let topScore: Double
    public let scores: [LabelScore]
}

public enum PrecheckDecision {
    public static func decide(imageEmbedding: [Float], labels: LabelSet, threshold: Double) -> PrecheckResult {
        let scored = labels.labels.map { label -> (Label, Double) in
            (label, cosine(imageEmbedding, label.embedding))
        }
        let all = scored.map { LabelScore(name: $0.0.name, score: $0.1) }
        let top = scored.max { $0.1 < $1.1 }!
        let bestFinancial = scored.filter { $0.0.isFinancial }.map(\.1).max() ?? -1
        let bestNonFinancial = scored.filter { !$0.0.isFinancial }.map(\.1).max() ?? -1
        let decision: PrecheckDecisionKind =
            (bestFinancial > bestNonFinancial && bestFinancial >= threshold) ? .upload : .ignore
        return PrecheckResult(decision: decision, topLabel: top.0.name, topScore: top.1, scores: all)
    }

    private static func cosine(_ a: [Float], _ b: [Float]) -> Double {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var dot: Double = 0, na: Double = 0, nb: Double = 0
        for i in a.indices {
            dot += Double(a[i]) * Double(b[i])
            na += Double(a[i]) * Double(a[i])
            nb += Double(b[i]) * Double(b[i])
        }
        guard na > 0, nb > 0 else { return 0 }
        return dot / (na.squareRoot() * nb.squareRoot())
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter PrecheckDecisionTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/ML/PrecheckDecision.swift apps/ios/Tests/AccountingHelperTests/PrecheckDecisionTests.swift
git commit -m "feat(ios): precheck decision rule (max-financial vs max-non-financial + threshold)"
```

---

### Task 9: ModelRunner protocol + Vision gate + fake

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/ML/ModelRunner.swift`
- Create: `apps/ios/Sources/AccountingHelper/ML/VisionGate.swift`
- Create: `apps/ios/Tests/AccountingHelperTests/Fakes/FakeModelRunner.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/VisionGateTests.swift` (SIMULATOR-ONLY)

**Interfaces:**
- Produces:
  - `protocol ImageGate: Sendable { func looksLikeDocument(_ image: CGImage) async -> Bool }`
  - `protocol ModelRunner: Sendable { func imageEmbedding(_ image: CGImage) async throws -> [Float] }`
  - `final class VisionGate: ImageGate` — uses `VNDetectDocumentSegmentationRequest`; returns true if a document rectangle is detected with confidence ≥ a cutoff. (Cheap pre-filter before MobileCLIP.)
  - `final class FakeModelRunner: ModelRunner` and `final class FakeGate: ImageGate` for unit tests.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/VisionGateTests.swift`:

```swift
import XCTest
import CoreGraphics
@testable import AccountingHelper

// SIMULATOR-ONLY: VNDetectDocumentSegmentationRequest needs the Vision runtime.
final class VisionGateTests: XCTestCase {
    func testBlankImageIsNotADocument() async throws {
        // A 32x32 solid-grey image has no document rectangle.
        let ctx = CGContext(data: nil, width: 32, height: 32, bitsPerComponent: 8,
                            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        let img = ctx.makeImage()!
        let gate = VisionGate()
        let result = await gate.looksLikeDocument(img)
        XCTAssertFalse(result)
    }
}
```

Create `apps/ios/Tests/AccountingHelperTests/Fakes/FakeModelRunner.swift`:

```swift
@testable import AccountingHelper
import CoreGraphics

final class FakeModelRunner: ModelRunner, @unchecked Sendable {
    var embedding: [Float] = [1, 0]
    var error: Error?
    func imageEmbedding(_ image: CGImage) async throws -> [Float] {
        if let error { throw error }
        return embedding
    }
}

final class FakeGate: ImageGate, @unchecked Sendable {
    var passes = true
    func looksLikeDocument(_ image: CGImage) async -> Bool { passes }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter VisionGateTests`
Expected: FAIL — `VisionGate`/`ModelRunner` undefined.

- [ ] **Step 3: Implement the protocols + VisionGate**

Create `apps/ios/Sources/AccountingHelper/ML/ModelRunner.swift`:

```swift
import CoreGraphics

public protocol ImageGate: Sendable {
    func looksLikeDocument(_ image: CGImage) async -> Bool
}

public protocol ModelRunner: Sendable {
    func imageEmbedding(_ image: CGImage) async throws -> [Float]
}
```

Create `apps/ios/Sources/AccountingHelper/ML/VisionGate.swift`:

```swift
import Vision
import CoreGraphics

public final class VisionGate: ImageGate {
    private let minConfidence: Float

    public init(minConfidence: Float = 0.5) {
        self.minConfidence = minConfidence
    }

    public func looksLikeDocument(_ image: CGImage) async -> Bool {
        await withCheckedContinuation { continuation in
            let request = VNDetectDocumentSegmentationRequest { req, _ in
                let hit = (req.results as? [VNRectangleObservation])?
                    .contains { $0.confidence >= self.minConfidence } ?? false
                continuation.resume(returning: hit)
            }
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            do { try handler.perform([request]) }
            catch { continuation.resume(returning: false) }
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter VisionGateTests` (simulator destination).
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/ML/ModelRunner.swift apps/ios/Sources/AccountingHelper/ML/VisionGate.swift apps/ios/Tests/AccountingHelperTests/Fakes/FakeModelRunner.swift apps/ios/Tests/AccountingHelperTests/VisionGateTests.swift
git commit -m "feat(ios): ImageGate/ModelRunner protocols + Vision document gate + fakes"
```

---

### Task 10: PhotoSource protocol + PhotoAsset + fake

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/Photos/PhotoAsset.swift`
- Create: `apps/ios/Sources/AccountingHelper/Photos/PhotoSource.swift`
- Create: `apps/ios/Tests/AccountingHelperTests/Fakes/FakePhotoSource.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/PhotoSourceContractTests.swift`

**Interfaces:**
- Produces:
  - `struct PhotoAsset: Equatable, Sendable { let localId: String; let capturedAt: Date }`
  - `protocol PhotoSource: Sendable { func authorizationStatus() -> PhotoAuthStatus; func requestAuthorization() async -> PhotoAuthStatus; func enumerateImages() async -> [PhotoAsset]; func loadOriginal(localId: String) async throws -> PhotoData }`
  - `enum PhotoAuthStatus: Sendable { case authorized, limited, denied, notDetermined }`
  - `struct PhotoData: Sendable { let bytes: Data; let utiType: String; let filename: String }`
  - `final class PhotoKitPhotoSource: PhotoSource` (real PhotoKit; limited access handled — `enumerateImages` returns whatever is accessible).
  - `final class FakePhotoSource: PhotoSource` for unit tests.

> The real PhotoKit enumeration / `requestImageDataAndOrientation` path is exercised only via SIMULATOR-ONLY tests with a seeded library; pure-logic tests use `FakePhotoSource`. Here we only assert the **fake honors the contract** so coordinator tests can rely on it.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/PhotoSourceContractTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class PhotoSourceContractTests: XCTestCase {
    func testFakeReturnsSeededAssetsAndData() async throws {
        let source = FakePhotoSource(assets: [
            PhotoAsset(localId: "A1", capturedAt: Date(timeIntervalSince1970: 10)),
        ], data: ["A1": PhotoData(bytes: Data([0xFF]), utiType: "public.heic", filename: "A1.HEIC")])

        let assets = await source.enumerateImages()
        XCTAssertEqual(assets.map(\.localId), ["A1"])
        let d = try await source.loadOriginal(localId: "A1")
        XCTAssertEqual(d.utiType, "public.heic")
        XCTAssertEqual(d.bytes, Data([0xFF]))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter PhotoSourceContractTests`
Expected: FAIL — types undefined.

- [ ] **Step 3: Implement value types + protocol + fake (+ real PhotoKit impl)**

Create `apps/ios/Sources/AccountingHelper/Photos/PhotoAsset.swift`:

```swift
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
```

Create `apps/ios/Sources/AccountingHelper/Photos/PhotoSource.swift`:

```swift
import Foundation
import Photos

public protocol PhotoSource: Sendable {
    func authorizationStatus() -> PhotoAuthStatus
    func requestAuthorization() async -> PhotoAuthStatus
    func enumerateImages() async -> [PhotoAsset]
    func loadOriginal(localId: String) async throws -> PhotoData
}

public enum PhotoSourceError: Error { case assetNotFound, dataUnavailable }

public final class PhotoKitPhotoSource: PhotoSource {
    public init() {}

    private func map(_ s: PHAuthorizationStatus) -> PhotoAuthStatus {
        switch s {
        case .authorized: return .authorized
        case .limited: return .limited
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .denied
        }
    }

    public func authorizationStatus() -> PhotoAuthStatus {
        map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    public func requestAuthorization() async -> PhotoAuthStatus {
        await withCheckedContinuation { c in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { c.resume(returning: self.map($0)) }
        }
    }

    public func enumerateImages() async -> [PhotoAsset] {
        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let result = PHAsset.fetchAssets(with: opts)
        var assets: [PhotoAsset] = []
        result.enumerateObjects { asset, _, _ in
            assets.append(PhotoAsset(localId: asset.localIdentifier,
                                     capturedAt: asset.creationDate ?? Date(timeIntervalSince1970: 0)))
        }
        return assets
    }

    public func loadOriginal(localId: String) async throws -> PhotoData {
        let fetch = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
        guard let asset = fetch.firstObject else { throw PhotoSourceError.assetNotFound }
        let resources = PHAssetResource.assetResources(for: asset)
        guard let resource = resources.first(where: { $0.type == .photo }) ?? resources.first else {
            throw PhotoSourceError.dataUnavailable
        }
        var buffer = Data()
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        return try await withCheckedThrowingContinuation { c in
            PHAssetResourceManager.default().requestData(for: resource, options: options) { chunk in
                buffer.append(chunk)
            } completionHandler: { error in
                if let error { c.resume(throwing: error) }
                else { c.resume(returning: PhotoData(bytes: buffer,
                                                     utiType: resource.uniformTypeIdentifier,
                                                     filename: resource.originalFilename)) }
            }
        }
    }
}
```

Create `apps/ios/Tests/AccountingHelperTests/Fakes/FakePhotoSource.swift`:

```swift
@testable import AccountingHelper
import Foundation

final class FakePhotoSource: PhotoSource, @unchecked Sendable {
    let assets: [PhotoAsset]
    let data: [String: PhotoData]
    var status: PhotoAuthStatus = .authorized
    init(assets: [PhotoAsset], data: [String: PhotoData]) { self.assets = assets; self.data = data }
    func authorizationStatus() -> PhotoAuthStatus { status }
    func requestAuthorization() async -> PhotoAuthStatus { status }
    func enumerateImages() async -> [PhotoAsset] { assets }
    func loadOriginal(localId: String) async throws -> PhotoData {
        guard let d = data[localId] else { throw PhotoSourceError.assetNotFound }
        return d
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter PhotoSourceContractTests`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/Photos/ apps/ios/Tests/AccountingHelperTests/Fakes/FakePhotoSource.swift apps/ios/Tests/AccountingHelperTests/PhotoSourceContractTests.swift
git commit -m "feat(ios): PhotoSource protocol + PhotoKit impl (limited-access aware) + fake"
```

---

### Task 11: MultipartBody + DocumentUploader

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/Net/MultipartBody.swift`
- Create: `apps/ios/Sources/AccountingHelper/Upload/DocumentUploader.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/MultipartBodyTests.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/DocumentUploaderTests.swift`

**Interfaces:**
- Consumes: `APIClient` (Task 4), `PhotoData` (Task 10), `PrecheckResult` (Task 8).
- Produces:
  - `struct MultipartBody { init(boundary: String); mutating func addField(name:String, value:String); mutating func addFile(name:String, filename:String, contentType:String, data:Data); func finished() -> (contentType: String, body: Data) }`
  - `struct UploadInput { let assetLocalId: String; let capturedAt: Date; let data: PhotoData; let precheck: PrecheckResult }`
  - `final class DocumentUploader` init `(client: APIClient, tokenProvider: @escaping () -> String?)`; `func upload(_ input: UploadInput) async throws -> Bool` — POSTs multipart to `/api/documents` with fields `channel=ios_photo_library`, `assetLocalId`, `capturedAt` (ISO-8601), `precheck` (JSON string), file part `file`. Returns true on 2xx; throws `UploadError.unauthorized` on 401, `UploadError.server(Int)` otherwise.

- [ ] **Step 1: Write the failing test (MultipartBody)**

Create `apps/ios/Tests/AccountingHelperTests/MultipartBodyTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class MultipartBodyTests: XCTestCase {
    func testBuildsMultipartWithFieldAndFile() {
        var body = MultipartBody(boundary: "BOUND")
        body.addField(name: "channel", value: "ios_photo_library")
        body.addFile(name: "file", filename: "A1.HEIC", contentType: "image/heic", data: Data([0x01, 0x02]))
        let (contentType, data) = body.finished()
        let text = String(data: data, encoding: .isoLatin1)!
        XCTAssertEqual(contentType, "multipart/form-data; boundary=BOUND")
        XCTAssertTrue(text.contains("name=\"channel\""))
        XCTAssertTrue(text.contains("ios_photo_library"))
        XCTAssertTrue(text.contains("filename=\"A1.HEIC\""))
        XCTAssertTrue(text.contains("Content-Type: image/heic"))
        XCTAssertTrue(text.hasSuffix("--BOUND--\r\n"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter MultipartBodyTests`
Expected: FAIL — `MultipartBody` undefined.

- [ ] **Step 3: Implement MultipartBody**

Create `apps/ios/Sources/AccountingHelper/Net/MultipartBody.swift`:

```swift
import Foundation

public struct MultipartBody {
    private let boundary: String
    private var data = Data()

    public init(boundary: String) { self.boundary = boundary }

    public mutating func addField(name: String, value: String) {
        data.append("--\(boundary)\r\n")
        data.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
        data.append("\(value)\r\n")
    }

    public mutating func addFile(name: String, filename: String, contentType: String, data fileData: Data) {
        data.append("--\(boundary)\r\n")
        data.append("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n")
        data.append("Content-Type: \(contentType)\r\n\r\n")
        data.append(fileData)
        data.append("\r\n")
    }

    public func finished() -> (contentType: String, body: Data) {
        var body = data
        body.append("--\(boundary)--\r\n")
        return ("multipart/form-data; boundary=\(boundary)", body)
    }
}

private extension Data {
    mutating func append(_ string: String) { append(Data(string.utf8)) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter MultipartBodyTests`
Expected: PASS.

- [ ] **Step 5: Write the failing test (DocumentUploader)**

Create `apps/ios/Tests/AccountingHelperTests/DocumentUploaderTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class DocumentUploaderTests: XCTestCase {
    private func input() -> UploadInput {
        UploadInput(
            assetLocalId: "A1",
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            data: PhotoData(bytes: Data([0x01]), utiType: "public.heic", filename: "A1.HEIC"),
            precheck: PrecheckResult(decision: .upload, topLabel: "receipt", topScore: 0.9,
                                     scores: [LabelScore(name: "receipt", score: 0.9)]))
    }

    func testPostsMultipartWithAllFields() async throws {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 201, data: Data()))]
        let uploader = DocumentUploader(client: api, tokenProvider: { "sess-1" })

        let ok = try await uploader.upload(input())

        XCTAssertTrue(ok)
        let req = api.sent.first!
        XCTAssertEqual(req.method, "POST")
        XCTAssertEqual(req.path, "/api/documents")
        XCTAssertEqual(req.bearer, "sess-1")
        let body = String(data: req.body!, encoding: .isoLatin1)!
        XCTAssertTrue(body.contains("name=\"channel\""))
        XCTAssertTrue(body.contains("ios_photo_library"))
        XCTAssertTrue(body.contains("name=\"assetLocalId\""))
        XCTAssertTrue(body.contains("A1"))
        XCTAssertTrue(body.contains("name=\"capturedAt\""))
        XCTAssertTrue(body.contains("2023-11-14")) // ISO-8601 date portion
        XCTAssertTrue(body.contains("name=\"precheck\""))
        XCTAssertTrue(body.contains("\"decision\":\"upload\""))
        XCTAssertTrue(body.contains("filename=\"A1.HEIC\""))
    }

    func testThrowsUnauthorizedOn401() async {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 401, data: Data()))]
        let uploader = DocumentUploader(client: api, tokenProvider: { "sess-1" })
        do { _ = try await uploader.upload(input()); XCTFail() }
        catch { XCTAssertEqual(error as? UploadError, .unauthorized) }
    }
}
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter DocumentUploaderTests`
Expected: FAIL — `DocumentUploader`/`UploadInput`/`UploadError` undefined.

- [ ] **Step 7: Implement DocumentUploader**

Create `apps/ios/Sources/AccountingHelper/Upload/DocumentUploader.swift`:

```swift
import Foundation

public struct UploadInput: Sendable {
    public let assetLocalId: String
    public let capturedAt: Date
    public let data: PhotoData
    public let precheck: PrecheckResult
    public init(assetLocalId: String, capturedAt: Date, data: PhotoData, precheck: PrecheckResult) {
        self.assetLocalId = assetLocalId; self.capturedAt = capturedAt
        self.data = data; self.precheck = precheck
    }
}

public enum UploadError: Error, Equatable { case unauthorized; case server(Int) }

public final class DocumentUploader {
    private let client: APIClient
    private let tokenProvider: () -> String?

    public init(client: APIClient, tokenProvider: @escaping () -> String?) {
        self.client = client
        self.tokenProvider = tokenProvider
    }

    public func upload(_ input: UploadInput) async throws -> Bool {
        var body = MultipartBody(boundary: "Boundary-\(UUID().uuidString)")
        body.addField(name: "channel", value: "ios_photo_library")
        body.addField(name: "assetLocalId", value: input.assetLocalId)
        let iso = ISO8601DateFormatter()
        body.addField(name: "capturedAt", value: iso.string(from: input.capturedAt))
        let precheckJSON = String(data: try JSONEncoder().encode(input.precheck), encoding: .utf8) ?? "{}"
        body.addField(name: "precheck", value: precheckJSON)
        let contentType = mime(for: input.data.utiType)
        body.addFile(name: "file", filename: input.data.filename,
                     contentType: contentType, data: input.data.bytes)
        let (ct, payload) = body.finished()

        let resp = try await client.send(APIRequest(
            method: "POST", path: "/api/documents", body: payload,
            contentType: ct, bearer: tokenProvider()))
        switch resp.status {
        case 200...299: return true
        case 401: throw UploadError.unauthorized
        default: throw UploadError.server(resp.status)
        }
    }

    private func mime(for uti: String) -> String {
        switch uti {
        case "public.heic", "public.heif": return "image/heic"
        case "public.jpeg": return "image/jpeg"
        case "public.png": return "image/png"
        default: return "application/octet-stream"
        }
    }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter DocumentUploaderTests`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/Net/MultipartBody.swift apps/ios/Sources/AccountingHelper/Upload/DocumentUploader.swift apps/ios/Tests/AccountingHelperTests/MultipartBodyTests.swift apps/ios/Tests/AccountingHelperTests/DocumentUploaderTests.swift
git commit -m "feat(ios): multipart builder + DocumentUploader (HEIC + precheck metadata)"
```

---

### Task 12: Model fetch script + manifest + real embeddings

**Files:**
- Create: `apps/ios/Scripts/fetch-model.sh`
- Create: `apps/ios/Resources/model-manifest.json`
- Modify: `apps/ios/Resources/label-embeddings.json` (real vectors)
- Modify: `apps/ios/Sources/AccountingHelper/ML/MobileCLIPRunner.swift` (created in Task 13 — manifest read here is forward-looking; keep this task to script + data)
- Test: `apps/ios/Tests/AccountingHelperTests/ModelManifestTests.swift`

**Interfaces:**
- Produces:
  - `apps/ios/Resources/model-manifest.json` = `{ "version": "s0-2024", "url": "https://...MobileCLIP-S0.mlpackage.zip", "sha256": "<hex>" }`.
  - `struct ModelManifest: Decodable, Equatable { let version: String; let url: URL; let sha256: String; static func bundled() throws -> ModelManifest }`
  - `Scripts/fetch-model.sh` — downloads the `.mlpackage`, verifies SHA-256 against the manifest, unzips into `apps/ios/Models/`, fails non-zero on mismatch.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/ModelManifestTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

final class ModelManifestTests: XCTestCase {
    func testBundledManifestHasURLAndChecksum() throws {
        let m = try ModelManifest.bundled()
        XCTAssertFalse(m.version.isEmpty)
        XCTAssertEqual(m.url.scheme, "https")
        XCTAssertEqual(m.sha256.count, 64) // hex sha-256
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter ModelManifestTests`
Expected: FAIL — `ModelManifest` + resource missing.

- [ ] **Step 3: Create the manifest + ModelManifest type**

Create `apps/ios/Resources/model-manifest.json` (fill `url`/`sha256` with the real pinned Apple MobileCLIP-S0 Core ML release values when known; use the published checksum):

```json
{
  "version": "s0-2024",
  "url": "https://docs-assets.developer.apple.com/ml-research/models/mobileclip/mobileclip_s0.mlpackage.zip",
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

> The engineer MUST replace the zero `sha256` with the real checksum of the pinned artifact (run `shasum -a 256` on the downloaded file once, paste it here). The test only checks length; CI correctness comes from the script's verification step.

Append to `apps/ios/Sources/AccountingHelper/ML/LabelSet.swift` (or a new `ModelManifest.swift`):

```swift
public struct ModelManifest: Decodable, Equatable, Sendable {
    public let version: String
    public let url: URL
    public let sha256: String

    public static func bundled() throws -> ModelManifest {
        guard let u = Bundle.module.url(forResource: "model-manifest", withExtension: "json") else {
            throw NSError(domain: "ModelManifest", code: 1)
        }
        return try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: u))
    }
}
```

- [ ] **Step 4: Create the fetch script**

Create `apps/ios/Scripts/fetch-model.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$HERE/Resources/model-manifest.json"
DEST="$HERE/Models"
mkdir -p "$DEST"

URL=$(/usr/bin/python3 -c "import json;print(json.load(open('$MANIFEST'))['url'])")
WANT=$(/usr/bin/python3 -c "import json;print(json.load(open('$MANIFEST'))['sha256'])")
TMP="$(mktemp -d)"
ZIP="$TMP/model.zip"

echo "Downloading $URL"
curl -fsSL "$URL" -o "$ZIP"
GOT=$(shasum -a 256 "$ZIP" | awk '{print $1}')
if [ "$GOT" != "$WANT" ]; then
  echo "checksum mismatch: want $WANT got $GOT" >&2
  exit 1
fi
echo "Unzipping into $DEST"
unzip -oq "$ZIP" -d "$DEST"
rm -rf "$TMP"
echo "Model ready in $DEST"
```

Make it executable: `chmod +x apps/ios/Scripts/fetch-model.sh`.

- [ ] **Step 5: Regenerate real label embeddings**

Run `apps/ios/Scripts/fetch-model.sh`, then encode each label `prompt` through the MobileCLIP-S0 **text** encoder (a short Python script using the published MobileCLIP weights or the Core ML text model) and overwrite `apps/ios/Resources/label-embeddings.json` with the real 512-dim vectors. Keep the same JSON schema as Task 7. Commit the regenerated JSON (vectors are small, ~20KB).

> This is the one step that needs the real model present locally. It is a one-time data-generation step run by the engineer, not part of the app runtime or CI build.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter ModelManifestTests`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add apps/ios/Scripts/fetch-model.sh apps/ios/Resources/model-manifest.json apps/ios/Resources/label-embeddings.json apps/ios/Sources/AccountingHelper/ML/LabelSet.swift apps/ios/Tests/AccountingHelperTests/ModelManifestTests.swift
git commit -m "feat(ios): model fetch script + pinned manifest + real label embeddings"
```

---

### Task 13: MobileCLIPRunner — real Core ML image embedding

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/ML/MobileCLIPRunner.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/MobileCLIPRunnerTests.swift` (SIMULATOR-ONLY, skipped when model absent)

**Interfaces:**
- Consumes: `ModelRunner` protocol (Task 9), the downloaded `.mlpackage` (Task 12).
- Produces: `final class MobileCLIPRunner: ModelRunner` init `(modelURL: URL)` (compiles + loads the Core ML image encoder); `imageEmbedding(_:)` preprocesses the `CGImage` to the model's input size and returns the L2-context raw embedding vector.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/MobileCLIPRunnerTests.swift`:

```swift
import XCTest
import CoreGraphics
@testable import AccountingHelper

// SIMULATOR-ONLY and skipped unless the model package exists in Models/.
final class MobileCLIPRunnerTests: XCTestCase {
    func testEmbeddingHasExpectedDimension() async throws {
        let modelURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Models/MobileCLIP-S0-image.mlpackage")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: modelURL.path),
                          "model not downloaded; run Scripts/fetch-model.sh")
        let runner = try MobileCLIPRunner(modelURL: modelURL)
        let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let img = ctx.makeImage()!
        let emb = try await runner.imageEmbedding(img)
        XCTAssertEqual(emb.count, 512)
    }
}
```

- [ ] **Step 2: Run test to verify it fails / skips**

Run: `cd apps/ios && swift test --filter MobileCLIPRunnerTests`
Expected: FAIL — `MobileCLIPRunner` undefined (or SKIP once defined but model absent).

- [ ] **Step 3: Implement MobileCLIPRunner**

Create `apps/ios/Sources/AccountingHelper/ML/MobileCLIPRunner.swift`:

```swift
import CoreML
import CoreGraphics
import Vision

public final class MobileCLIPRunner: ModelRunner {
    private let model: MLModel

    public init(modelURL: URL) throws {
        let compiled = try MLModel.compileModel(at: modelURL)
        self.model = try MLModel(contentsOf: compiled)
    }

    public func imageEmbedding(_ image: CGImage) async throws -> [Float] {
        // MobileCLIP-S0 image encoder input: 256x256 RGB (per model card).
        let side = 256
        let provider = try imageFeatureProvider(image, side: side)
        let out = try model.prediction(from: provider)
        guard let name = model.modelDescription.outputDescriptionsByName.keys.first,
              let multi = out.featureValue(for: name)?.multiArrayValue else {
            return []
        }
        return (0..<multi.count).map { Float(truncating: multi[$0]) }
    }

    private func imageFeatureProvider(_ image: CGImage, side: Int) throws -> MLFeatureProvider {
        let inputName = model.modelDescription.inputDescriptionsByName.keys.first ?? "image"
        let buffer = try pixelBuffer(from: image, side: side)
        return try MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(pixelBuffer: buffer)])
    }

    private func pixelBuffer(from image: CGImage, side: Int) throws -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        let attrs = [kCVPixelBufferCGImageCompatibilityKey: true,
                     kCVPixelBufferCGBitmapContextCompatibilityKey: true] as CFDictionary
        CVPixelBufferCreate(kCFAllocatorDefault, side, side, kCVPixelFormatType_32ARGB, attrs, &pb)
        guard let buffer = pb else { throw NSError(domain: "MobileCLIPRunner", code: 2) }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer),
                            width: side, height: side, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return buffer
    }
}
```

> The exact input name/size and output name depend on the published MobileCLIP-S0 Core ML package; the implementation reads them from `modelDescription` rather than hard-coding, so it adapts. Confirm `512` output dim against the actual model in Task 12's encode step.

- [ ] **Step 4: Run test to verify it passes (or skips cleanly)**

Run: `cd apps/ios && swift test --filter MobileCLIPRunnerTests`
Expected: SKIP if model absent, PASS if present on a simulator with the package downloaded.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/ML/MobileCLIPRunner.swift apps/ios/Tests/AccountingHelperTests/MobileCLIPRunnerTests.swift
git commit -m "feat(ios): MobileCLIPRunner Core ML image embedding"
```

---

### Task 14: ScanCoordinator — orchestration

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/Scan/ScanCoordinator.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/ScanCoordinatorTests.swift`

**Interfaces:**
- Consumes: `PhotoSource` (Task 10), `ImageGate` + `ModelRunner` (Task 9), `LabelSet` (Task 7), `PrecheckDecision` (Task 8), `DocumentUploader` (Task 11), `ScanStateStore` (Task 6), `AppSettings` (provides `threshold`, `autoUpload`).
- Produces:
  - `struct ScanSummary: Equatable, Sendable { let examined: Int; let uploaded: Int; let ignored: Int; let skipped: Int; let failed: Int }`
  - `final class ScanCoordinator` init `(photos:, gate:, model:, labels:, uploader:, store:, settings:, decode: @escaping (PhotoData) -> CGImage?)`; `func scanOnce() async -> ScanSummary` — for each enumerated asset not already in the store: decode → gate (skip→ignore record? no: gate-fail means ignore) → embed → decide → if upload & autoUpload: upload, on success record uploaded; on failure leave unrecorded (retry next scan, counts as failed); else record ignored.

- [ ] **Step 1: Write the failing test**

Create `apps/ios/Tests/AccountingHelperTests/ScanCoordinatorTests.swift`:

```swift
import XCTest
import CoreGraphics
@testable import AccountingHelper

final class ScanCoordinatorTests: XCTestCase {
    private func oneByOne() -> CGImage {
        let ctx = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        return ctx.makeImage()!
    }

    private func labels() -> LabelSet {
        LabelSet(labels: [
            Label(name: "receipt", prompt: "", isFinancial: true, embedding: [1, 0]),
            Label(name: "selfie", prompt: "", isFinancial: false, embedding: [0, 1]),
        ])
    }

    private func make(uploadResult: Result<Bool, Error>, modelEmbedding: [Float], gatePasses: Bool,
                      assets: [PhotoAsset], settings: AppSettings)
        -> (ScanCoordinator, FakeScanStateStore, FakeAPIClient) {
        let api = FakeAPIClient()
        switch uploadResult {
        case .success: api.responses = [.success(APIResponse(status: 201, data: Data()))]
        case .failure(let e): api.responses = [.failure(e)]
        }
        let store = FakeScanStateStore()
        let model = FakeModelRunner(); model.embedding = modelEmbedding
        let gate = FakeGate(); gate.passes = gatePasses
        let source = FakePhotoSource(
            assets: assets,
            data: Dictionary(uniqueKeysWithValues: assets.map {
                ($0.localId, PhotoData(bytes: Data([0x1]), utiType: "public.heic", filename: "\($0.localId).HEIC")) }))
        let uploader = DocumentUploader(client: api, tokenProvider: { "sess" })
        let coord = ScanCoordinator(photos: source, gate: gate, model: model, labels: labels(),
                                    uploader: uploader, store: store, settings: settings,
                                    decode: { _ in self.oneByOne() })
        return (coord, store, api)
    }

    func testUploadsFinancialAsset() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, api) = make(uploadResult: .success(true), modelEmbedding: [1, 0],
                                       gatePasses: true,
                                       assets: [PhotoAsset(localId: "A1", capturedAt: Date())], settings: s)
        let summary = await coord.scanOnce()
        XCTAssertEqual(summary.uploaded, 1)
        XCTAssertEqual(try? store.status(of: "A1"), .uploaded)
        XCTAssertEqual(api.sent.count, 1)
    }

    func testIgnoresNonFinancialAndRecordsIgnored() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, _) = make(uploadResult: .success(true), modelEmbedding: [0, 1],
                                     gatePasses: true,
                                     assets: [PhotoAsset(localId: "A2", capturedAt: Date())], settings: s)
        let summary = await coord.scanOnce()
        XCTAssertEqual(summary.ignored, 1)
        XCTAssertEqual(try? store.status(of: "A2"), .ignored)
    }

    func testGateFailSkipsModelAndRecordsIgnored() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, _) = make(uploadResult: .success(true), modelEmbedding: [1, 0],
                                     gatePasses: false,
                                     assets: [PhotoAsset(localId: "A3", capturedAt: Date())], settings: s)
        let summary = await coord.scanOnce()
        XCTAssertEqual(summary.ignored, 1)
        XCTAssertEqual(try? store.status(of: "A3"), .ignored)
    }

    func testFailedUploadLeavesAssetUnrecordedForRetry() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, _) = make(uploadResult: .failure(UploadError.server(500)),
                                     modelEmbedding: [1, 0], gatePasses: true,
                                     assets: [PhotoAsset(localId: "A4", capturedAt: Date())], settings: s)
        let summary = await coord.scanOnce()
        XCTAssertEqual(summary.failed, 1)
        XCTAssertNil(try? store.status(of: "A4")) // retried next scan
    }

    func testAlreadyHandledAssetIsSkipped() async {
        let s = AppSettings(threshold: 0.5, autoUpload: true)
        let (coord, store, api) = make(uploadResult: .success(true), modelEmbedding: [1, 0],
                                       gatePasses: true,
                                       assets: [PhotoAsset(localId: "A5", capturedAt: Date())], settings: s)
        try? store.record(LogEntry(assetLocalId: "A5", outcome: .uploaded, topLabel: "receipt", score: 0.9, at: Date()))
        let summary = await coord.scanOnce()
        XCTAssertEqual(summary.skipped, 1)
        XCTAssertEqual(api.sent.count, 0)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter ScanCoordinatorTests`
Expected: FAIL — `ScanCoordinator`/`AppSettings`/`ScanSummary` undefined.

- [ ] **Step 3: Implement AppSettings (minimal value type) + ScanCoordinator**

Create `apps/ios/Sources/AccountingHelper/State/AppSettings.swift`:

```swift
import Foundation

public struct AppSettings: Equatable, Sendable {
    public var threshold: Double
    public var autoUpload: Bool
    public init(threshold: Double = 0.22, autoUpload: Bool = true) {
        self.threshold = threshold
        self.autoUpload = autoUpload
    }
}

/// UserDefaults-backed persistence for AppSettings (non-secret config).
public enum AppSettingsStore {
    public static func load(_ defaults: UserDefaults = .standard) -> AppSettings {
        let t = defaults.object(forKey: "threshold") as? Double
        let a = defaults.object(forKey: "autoUpload") as? Bool
        return AppSettings(threshold: t ?? 0.22, autoUpload: a ?? true)
    }
    public static func save(_ s: AppSettings, _ defaults: UserDefaults = .standard) {
        defaults.set(s.threshold, forKey: "threshold")
        defaults.set(s.autoUpload, forKey: "autoUpload")
    }
}
```

> Default threshold `0.22` is deliberately liberal (recall over precision; backend filters). Calibrate against the Log screen.

Create `apps/ios/Sources/AccountingHelper/Scan/ScanCoordinator.swift`:

```swift
import Foundation
import CoreGraphics

public struct ScanSummary: Equatable, Sendable {
    public var examined = 0, uploaded = 0, ignored = 0, skipped = 0, failed = 0
}

public final class ScanCoordinator {
    private let photos: PhotoSource
    private let gate: ImageGate
    private let model: ModelRunner
    private let labels: LabelSet
    private let uploader: DocumentUploader
    private let store: ScanStateStore
    private let settings: AppSettings
    private let decode: (PhotoData) -> CGImage?

    public init(photos: PhotoSource, gate: ImageGate, model: ModelRunner, labels: LabelSet,
                uploader: DocumentUploader, store: ScanStateStore, settings: AppSettings,
                decode: @escaping (PhotoData) -> CGImage?) {
        self.photos = photos; self.gate = gate; self.model = model; self.labels = labels
        self.uploader = uploader; self.store = store; self.settings = settings; self.decode = decode
    }

    public func scanOnce() async -> ScanSummary {
        var summary = ScanSummary()
        let assets = await photos.enumerateImages()
        for asset in assets {
            if (try? store.status(of: asset.localId)) ?? nil != nil { summary.skipped += 1; continue }
            summary.examined += 1
            guard let data = try? await photos.loadOriginal(localId: asset.localId),
                  let image = decode(data) else { summary.failed += 1; continue }

            if await gate.looksLikeDocument(image) == false {
                try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .ignored,
                                           topLabel: "gate:not_document", score: 0, at: Date()))
                summary.ignored += 1; continue
            }
            guard let emb = try? await model.imageEmbedding(image) else { summary.failed += 1; continue }
            let result = PrecheckDecision.decide(imageEmbedding: emb, labels: labels, threshold: settings.threshold)

            if result.decision == .upload && settings.autoUpload {
                let input = UploadInput(assetLocalId: asset.localId, capturedAt: asset.capturedAt,
                                        data: data, precheck: result)
                do {
                    _ = try await uploader.upload(input)
                    try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .uploaded,
                                               topLabel: result.topLabel, score: result.topScore, at: Date()))
                    summary.uploaded += 1
                } catch {
                    summary.failed += 1 // unrecorded → retried next scan
                }
            } else {
                try? store.record(LogEntry(assetLocalId: asset.localId, outcome: .ignored,
                                           topLabel: result.topLabel, score: result.topScore, at: Date()))
                summary.ignored += 1
            }
        }
        return summary
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter ScanCoordinatorTests`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/State/AppSettings.swift apps/ios/Sources/AccountingHelper/Scan/ScanCoordinator.swift apps/ios/Tests/AccountingHelperTests/ScanCoordinatorTests.swift
git commit -m "feat(ios): ScanCoordinator orchestration (gate→embed→decide→upload→record)"
```

---

### Task 15: SwiftUI screens + app wiring + change observer

**Files:**
- Create: `apps/ios/Sources/AccountingHelper/App.swift`
- Create: `apps/ios/Sources/AccountingHelper/UI/LoginView.swift`, `LoginViewModel.swift`, `QRScannerView.swift`
- Create: `apps/ios/Sources/AccountingHelper/UI/HomeView.swift`, `HomeViewModel.swift`
- Create: `apps/ios/Sources/AccountingHelper/UI/LogView.swift`, `LogViewModel.swift`
- Create: `apps/ios/Sources/AccountingHelper/UI/SettingsView.swift`, `SettingsViewModel.swift`
- Create: `apps/ios/Sources/AccountingHelper/Photos/PhotoLibraryObserver.swift`
- Test: `apps/ios/Tests/AccountingHelperTests/ViewModelTests.swift`

**Interfaces:**
- Consumes: every prior component.
- Produces: `@MainActor @Observable` view models (`LoginViewModel`, `HomeViewModel`, `LogViewModel`, `SettingsViewModel`) whose logic is unit-testable with fakes; SwiftUI views are thin and untested (rendered only on device). `PhotoLibraryObserver: NSObject, PHPhotoLibraryChangeObserver` triggers `scanOnce()` while the app is foregrounded.

> Only the **view models** get unit tests (they hold the logic). The SwiftUI `View`s, `QRScannerView` (AVFoundation), and `PhotoLibraryObserver` registration are wired on device and verified manually / via UI tests later — out of unit-test scope.

- [ ] **Step 1: Write the failing test (view models)**

Create `apps/ios/Tests/AccountingHelperTests/ViewModelTests.swift`:

```swift
import XCTest
@testable import AccountingHelper

@MainActor
final class ViewModelTests: XCTestCase {
    func testLoginViewModelEnrollsAndSetsAuthed() async {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 201, data: #"{"accessToken":"s"}"#.data(using: .utf8)!))]
        let keychain = FakeKeychain()
        let auth = AuthService(apiFor: { _ in api }, keychain: keychain)
        let vm = LoginViewModel(auth: auth, deviceName: "iPhone")
        await vm.handleScan(#"{"v":1,"api":"https://api.test","enroll":"e"}"#)
        XCTAssertTrue(vm.isAuthenticated)
        XCTAssertNil(vm.errorMessage)
    }

    func testLoginViewModelSurfacesParseError() async {
        let auth = AuthService(apiFor: { _ in FakeAPIClient() }, keychain: FakeKeychain())
        let vm = LoginViewModel(auth: auth, deviceName: "iPhone")
        await vm.handleScan("garbage")
        XCTAssertFalse(vm.isAuthenticated)
        XCTAssertNotNil(vm.errorMessage)
    }

    func testHomeViewModelReportsCounts() throws {
        let store = FakeScanStateStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        let vm = HomeViewModel(store: store)
        vm.refresh()
        XCTAssertEqual(vm.uploadedCount, 1)
    }

    func testSettingsViewModelResetClearsStore() throws {
        let store = FakeScanStateStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        let vm = SettingsViewModel(store: store, settings: AppSettings(), onSettingsChange: { _ in })
        vm.resetCursor()
        XCTAssertEqual(try store.counts().uploaded, 0)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/ios && swift test --filter ViewModelTests`
Expected: FAIL — view models undefined.

- [ ] **Step 3: Implement the view models**

Create `apps/ios/Sources/AccountingHelper/UI/LoginViewModel.swift`:

```swift
import Foundation

@MainActor
@Observable
public final class LoginViewModel {
    private let auth: AuthService
    private let deviceName: String
    public var isAuthenticated = false
    public var errorMessage: String?

    public init(auth: AuthService, deviceName: String) {
        self.auth = auth; self.deviceName = deviceName
    }

    public func handleScan(_ raw: String) async {
        errorMessage = nil
        do {
            let payload = try QRPayload.parse(raw)
            _ = try await auth.enroll(payload: payload, deviceName: deviceName)
            isAuthenticated = true
        } catch {
            errorMessage = "\(error)"
        }
    }
}
```

Create `apps/ios/Sources/AccountingHelper/UI/HomeViewModel.swift`:

```swift
import Foundation

@MainActor
@Observable
public final class HomeViewModel {
    private let store: ScanStateStore
    public var uploadedCount = 0
    public var ignoredCount = 0
    public var lastScan: Date?

    public init(store: ScanStateStore) { self.store = store }

    public func refresh() {
        let c = (try? store.counts()) ?? (0, 0)
        uploadedCount = c.uploaded
        ignoredCount = c.ignored
    }
}
```

Create `apps/ios/Sources/AccountingHelper/UI/LogViewModel.swift`:

```swift
import Foundation

@MainActor
@Observable
public final class LogViewModel {
    private let store: ScanStateStore
    public var entries: [LogEntry] = []
    public init(store: ScanStateStore) { self.store = store }
    public func refresh() { entries = (try? store.recentLog(limit: 200)) ?? [] }
}
```

Create `apps/ios/Sources/AccountingHelper/UI/SettingsViewModel.swift`:

```swift
import Foundation

@MainActor
@Observable
public final class SettingsViewModel {
    private let store: ScanStateStore
    private let onSettingsChange: (AppSettings) -> Void
    public var settings: AppSettings { didSet { onSettingsChange(settings) } }

    public init(store: ScanStateStore, settings: AppSettings,
                onSettingsChange: @escaping (AppSettings) -> Void) {
        self.store = store
        self.settings = settings
        self.onSettingsChange = onSettingsChange
    }

    public func resetCursor() { try? store.reset() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/ios && swift test --filter ViewModelTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the SwiftUI views, QR scanner, observer, and app wiring**

Create the thin SwiftUI views (`LoginView`, `HomeView`, `LogView`, `SettingsView`) binding to the view models above; `QRScannerView` as a `UIViewControllerRepresentable` over `AVCaptureSession` with `AVCaptureMetadataOutput` (`.qr`) calling `LoginViewModel.handleScan`; `PhotoLibraryObserver` registering with `PHPhotoLibrary.shared().register(...)` and invoking `ScanCoordinator.scanOnce()` on `photoLibraryDidChange`; and `App.swift` (`@main`) composing the dependency graph (real `SystemKeychainStore`, `URLSessionAPIClient` bound to the stored base URL, `PhotoKitPhotoSource`, `VisionGate`, `MobileCLIPRunner`, `GRDBScanStateStore` at `Application Support/scan.sqlite`) and a `TabView` of the four screens, plus `.task`/`.onChange(of: scenePhase)` triggers calling `scanOnce()` on launch and foreground. These are device-verified, not unit-tested.

Add the required `Info.plist` usage strings: `NSCameraUsageDescription` (QR scan) and `NSPhotoLibraryUsageDescription` (scanning). Register `BGTaskScheduler` identifiers are **out of scope** — leave a `// TODO(later): BackgroundTasks` stub in `App.swift`.

- [ ] **Step 6: Commit**

```bash
git add apps/ios/Sources/AccountingHelper/UI/ apps/ios/Sources/AccountingHelper/App.swift apps/ios/Sources/AccountingHelper/Photos/PhotoLibraryObserver.swift apps/ios/Tests/AccountingHelperTests/ViewModelTests.swift
git commit -m "feat(ios): view models + SwiftUI screens + QR scanner + foreground scan triggers"
```

---

### Task 16: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole unit suite (host)**

Run: `cd apps/ios && swift test`
Expected: all non-simulator tests PASS; SIMULATOR-ONLY tests are excluded from the host `swift test` run (they live in files guarded by availability / require Vision/Keychain — run them separately).

- [ ] **Step 2: Run simulator-bound tests**

Run via Xcode against an iOS 18 simulator (or `xcodebuild test -scheme AccountingHelper -destination 'platform=iOS Simulator,name=iPhone 16'`):
- `KeychainStoreTests`, `VisionGateTests`, and (if model downloaded) `MobileCLIPRunnerTests`.
Expected: PASS (MobileCLIPRunnerTests SKIPs if `Models/` empty).

- [ ] **Step 3: Manual device smoke (documented, not automated)**

Confirm: scan QR from the SPA/CLI → enrolls → Home shows counts → drop a receipt photo in the library → it uploads and appears in the ERP intake; a selfie does not. Logout clears Keychain (re-launch returns to Login).

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "chore(ios): verification fixups"
```

---

## Self-Review

**Spec coverage (locked decisions Q1–Q11 + backend reuse):**
- Q1 `apps/ios` monorepo → Task 1. ✅
- Q2 enrollment consumed, not re-implemented → referenced in Global Constraints + Task 5 (calls `/api/mobile/sessions`). ✅
- Q3 extended upload (`channel`/`assetLocalId`/`capturedAt`/`precheck`) → Task 11 builds exactly those fields; backend specced in sibling plan. ✅
- Q4 layered Vision gate → MobileCLIP → Tasks 9 (gate), 13 (CLIP), 14 (coordinator chains them). ✅
- Q5 auto-upload, liberal threshold → Task 14 (`autoUpload` path), Task 14 `AppSettings` default `0.22`. ✅
- Q6 SQLite state, idempotent by assetLocalId, retry failed, limited access day one → Tasks 6 (GRDB store, `ON CONFLICT`), 10 (limited-access mapping), 14 (failed→unrecorded retry). ✅
- Q7 HEIC original → Task 11 (`image/heic`, original bytes, no client conversion). ✅
- Q8 iOS 18+, SPM-only, GRDB only → Task 1 (`platforms: [.iOS(.v18)]`, single dep). ✅
- Q9 foreground scan + change observer, BGTask deferred → Task 15 (`scenePhase`/`.task` triggers + `PhotoLibraryObserver`; BGTask explicit TODO stub). ✅
- Q10 build-script model fetch by pin+SHA256, gitignored Models/, label embeddings JSON in repo, max-fin-vs-non-fin + threshold rule → Tasks 12 (script/manifest), 1 (.gitignore Models/), 7 (embeddings JSON), 8 (decision rule). ✅
- Q11 four screens (Login/Home/Log/Settings), no landing → Task 15. ✅
- Keychain-only secrets → Task 3 + constraint; settings (non-secret) in UserDefaults (Task 14). ✅

**Placeholder scan:** The only intentional placeholders are the **embedding vectors** in `label-embeddings.json` (Task 7) and the `url`/`sha256` in `model-manifest.json` (Task 12) — both are *data* that the engineer fills from the real pinned model in Task 12, with explicit instructions and a verification step. No code step contains TBD/TODO except the deliberate `BackgroundTasks` out-of-scope stub (Q9).

**Type consistency:** `APIRequest`/`APIResponse` (Task 4) used identically in Tasks 5, 11, 14. `PhotoData` (Task 10) consumed by Tasks 11, 14. `PrecheckResult` (Task 8) produced by `PrecheckDecision.decide` and consumed by `DocumentUploader`/`ScanCoordinator`. `LogEntry`/`AssetOutcome` (Task 6) used by coordinator + view models. `ModelRunner.imageEmbedding(_:) -> [Float]` consistent between fake (Task 9), real (Task 13), and consumer (Task 14). `AppSettings` (Task 14) consumed by coordinator + SettingsViewModel. ✅

**Risks / gaps noticed (flagged for the parent):**
1. **MobileCLIP-S0 Core ML specifics are unverified** — exact `.mlpackage` URL, SHA-256, input tensor name/size (assumed 256×256), and output dim (assumed 512) must be confirmed against Apple's published artifact. Tasks 12/13 read shapes from `modelDescription` to soften this, but the manifest URL/checksum and the 512-dim label vectors are hard external dependencies.
2. **Two-encoder model** — MobileCLIP ships separate image and text encoders. This plan runs only the **image** encoder at runtime (text embeddings precomputed offline). The fetch script must pull the image-encoder package specifically; if Apple ships a combined package, Task 13's model-loading needs the right sub-model.
3. **Xcode project vs SPM** — the plan builds/tests the logic as an SPM library (host-runnable). Shipping an actual `.app` (Info.plist, entitlements, signing, app target) is assumed to be a thin Xcode wrapper around the library, created once during Task 15; it is not itself TDD-covered.
4. **VNDetectDocumentSegmentationRequest availability** — confirm it's the best cheap gate on iOS 18; an alternative is `VNGenerateImageFeaturePrintRequest` distance to a reference, but segmentation is the simplest document/non-document signal.
5. **`source_identifier` uniqueness** — backend dedup is by file `hash`, not `assetLocalId`; the iOS local store prevents re-upload of the same asset, but two different assets with identical bytes will still dedup server-side (expected, documented in the backend plan).
6. **No pagination on enumerate** — `enumerateImages()` returns the whole library each scan; for a 20k-photo library this is fine to fetch (PHAsset is lazy) but the per-asset loop should likely cap work per foreground cycle (not specced — possible follow-up).
