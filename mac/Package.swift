// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AwakeBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "AwakeBar", path: "Sources/AwakeBar"),
        .testTarget(name: "AwakeBarTests", dependencies: ["AwakeBar"], path: "Tests/AwakeBarTests")
    ]
)
