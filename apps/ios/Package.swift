// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AccountingHelper",
    platforms: [.macOS(.v14), .iOS(.v18)],
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
            path: "Sources/AccountingHelper",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "AccountingHelperTests",
            dependencies: ["AccountingHelper"]
        ),
    ]
)
