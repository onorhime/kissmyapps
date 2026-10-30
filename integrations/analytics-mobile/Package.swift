// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "KissMyApps",
    platforms: [.iOS(.v13), .macOS(.v10_15)],
    products: [
        .library(name: "KissMyApps", targets: ["KissMyApps"]),
    ],
    targets: [
        .target(name: "KissMyApps", path: "ios/Sources/KissMyApps"),
        .testTarget(name: "KissMyAppsTests", dependencies: ["KissMyApps"], path: "ios/Tests/KissMyAppsTests"),
    ]
)
