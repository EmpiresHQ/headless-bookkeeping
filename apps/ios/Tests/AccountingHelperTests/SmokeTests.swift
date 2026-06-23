import Testing
@testable import AccountingHelper

@Suite struct SmokeTests {
    @Test func libraryLinks() {
        // Compiles + links the library and GRDB. The marker proves the
        // module is importable before any real type exists.
        #expect(AccountingHelperModuleMarker.ok == true)
    }
}
