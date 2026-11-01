// swift-tools-version: 5.9
// The iOS side of the KissMyApps Flutter plugin, for apps that use Swift Package Manager.

import PackageDescription

let package = Package(
    name: "kissmyapps",
    platforms: [
        .iOS("15.0")
    ],
    products: [
        .library(name: "kissmyapps", targets: ["kissmyapps"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework")
    ],
    targets: [
        .target(
            name: "kissmyapps",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework")
            ]
        )
    ]
)
