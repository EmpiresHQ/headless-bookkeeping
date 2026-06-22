import Testing
import Foundation
@testable import AccountingHelper

@MainActor
@Suite struct ViewModelTests {
    @Test func loginViewModelEnrollsAndSetsAuthed() async {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 201, data: #"{"accessToken":"s"}"#.data(using: .utf8)!))]
        let keychain = FakeKeychain()
        let auth = AuthService(apiFor: { _ in api }, keychain: keychain)
        let vm = LoginViewModel(auth: auth, deviceName: "iPhone")
        await vm.handleScan(#"{"v":1,"api":"https://api.test","enroll":"e"}"#)
        #expect(vm.isAuthenticated)
        #expect(vm.errorMessage == nil)
    }

    @Test func loginViewModelSurfacesParseError() async {
        let auth = AuthService(apiFor: { _ in FakeAPIClient() }, keychain: FakeKeychain())
        let vm = LoginViewModel(auth: auth, deviceName: "iPhone")
        await vm.handleScan("garbage")
        #expect(!vm.isAuthenticated)
        #expect(vm.errorMessage != nil)
    }

    @Test func loginViewModelFiresOnAuthenticatedOnSuccess() async {
        let api = FakeAPIClient()
        api.responses = [.success(APIResponse(status: 201, data: #"{"accessToken":"s"}"#.data(using: .utf8)!))]
        let auth = AuthService(apiFor: { _ in api }, keychain: FakeKeychain())
        let vm = LoginViewModel(auth: auth, deviceName: "iPhone")
        var fired = false
        vm.onAuthenticated = { fired = true }
        await vm.handleScan(#"{"v":1,"api":"https://api.test","enroll":"e"}"#)
        #expect(fired)
    }

    @Test func loginViewModelDoesNotFireOnAuthenticatedOnError() async {
        let auth = AuthService(apiFor: { _ in FakeAPIClient() }, keychain: FakeKeychain())
        let vm = LoginViewModel(auth: auth, deviceName: "iPhone")
        var fired = false
        vm.onAuthenticated = { fired = true }
        await vm.handleScan("garbage")
        #expect(!fired)
    }

    @Test func homeViewModelToggleSyncFlipsAndNotifies() {
        let vm = HomeViewModel(store: FakeScanStateStore(), syncEnabled: false)
        var got: [Bool] = []
        vm.onSetSync = { got.append($0) }
        vm.toggleSync()
        #expect(vm.syncEnabled == true)
        vm.toggleSync()
        #expect(vm.syncEnabled == false)
        #expect(got == [true, false])
    }

    @Test func homeViewModelReportsCounts() throws {
        let store = FakeScanStateStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        let vm = HomeViewModel(store: store)
        vm.refresh()
        #expect(vm.uploadedCount == 1)
    }

    @Test func settingsViewModelResetClearsStore() throws {
        let store = FakeScanStateStore()
        try store.record(LogEntry(assetLocalId: "A1", outcome: .uploaded, topLabel: "r", score: 0.9, at: Date()))
        let vm = SettingsViewModel(store: store, settings: AppSettings(), onSettingsChange: { _ in })
        vm.resetCursor()
        #expect(try store.counts().uploaded == 0)
    }
}
