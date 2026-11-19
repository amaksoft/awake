import XCTest
@testable import AwakeBar

// Resolution policy without touching the real filesystem or spawning shells.
private func stubDeps(
    files: Set<String> = [],
    executables: Set<String> = [],
    env: [String: String] = [:],
    cliPathDefault: String? = nil,
    probes: [String: String] = [:], // command -> stdout path
    now: @escaping () -> Date = Date.init
) -> CLIResolverDeps {
    CLIResolverDeps(
        home: "/Users/test",
        env: env,
        cliPathDefault: cliPathDefault,
        fileExists: { files.contains($0) },
        isExecutable: { executables.contains($0) },
        shellProbe: { _, command in
            guard let hit = probes[command] else { return nil }
            return (hit.data(using: .utf8), 0)
        },
        now: now
    )
}

final class CLIResolverTests: XCTestCase {
    func testEnvOverrideWins() {
        let deps = stubDeps(
            files: ["/custom/awake"],
            executables: ["/custom/awake"],
            env: ["AWAKE_CLI": "/custom/awake"]
        )
        // Non-.js path runs directly, no runtime pairing needed.
        XCTAssertEqual(CLIResolver(deps: deps).resolveInvocation(), ["/custom/awake"])
    }

    func testEnvOverrideIgnoredWhenMissing() {
        let deps = stubDeps(env: ["AWAKE_CLI": "/nonexistent/awake"])
        XCTAssertNil(CLIResolver(deps: deps).resolveInvocation())
    }

    func testPairRuntimeRejectsJsWithoutRuntime() {
        // resolvingSymlinksInPath passes nonexistent paths through, so the
        // .js branch is reachable without touching the real filesystem.
        let deps = stubDeps(files: [], executables: [], probes: [:])
        XCTAssertNil(CLIResolver(deps: deps).pairRuntime(cli: "/nope/awake.js"))
    }

    func testPairRuntimeFallsBackToLoginShellRuntime() {
        let nvmBun = "/Users/test/.nvm/versions/node/v22/bin/bun"
        let deps = stubDeps(
            files: [],
            executables: [nvmBun],
            probes: ["command -v bun": nvmBun]
        )
        XCTAssertEqual(
            CLIResolver(deps: deps).pairRuntime(cli: "/x/awake.js"),
            [nvmBun, "/x/awake.js"]
        )
    }

    func testResolveSkipsUnpairableCandidate() {
        // /opt/homebrew/bin/awake exists and runs directly; the .bun entry
        // is absent so the loop must reach homebrew. (The .js-symlink skip
        // is covered at pairRuntime level above.)
        let deps = stubDeps(
            files: ["/opt/homebrew/bin/awake"],
            executables: ["/opt/homebrew/bin/awake"]
        )
        XCTAssertEqual(
            CLIResolver(deps: deps).resolveInvocation(),
            ["/opt/homebrew/bin/awake"]
        )
    }

    func testProbeResultsAreCached() {
        var probeCalls = 0
        let deps = CLIResolverDeps(
            home: "/Users/test",
            env: ["SHELL": "/bin/zsh"],
            cliPathDefault: nil,
            fileExists: { _ in false },
            isExecutable: { $0 == "/bin/zsh" },
            shellProbe: { _, _ in probeCalls += 1; return ("/x".data(using: .utf8), 0) },
            now: Date.init
        )
        let r = CLIResolver(deps: deps)
        XCTAssertEqual(r.loginShellProbe("command -v awake"), "/x")
        XCTAssertEqual(r.loginShellProbe("command -v awake"), "/x")
        XCTAssertEqual(probeCalls, 1, "second probe must come from cache")
    }

    func testShellPrecedencePutsLoginShellFirst() {
        let deps = stubDeps(executables: ["/bin/zsh", "/bin/sh"], env: ["SHELL": "/bin/zsh"])
        XCTAssertEqual(CLIResolver(deps: deps).loginShells().first, "/bin/zsh")
        let noEnv = stubDeps(env: [:])
        XCTAssertEqual(CLIResolver(deps: noEnv).loginShells().first, "/bin/zsh")
    }
}

final class ResponsePolicyTests: XCTestCase {
    private func statusJSON(enabled: Bool) -> Data {
        """
        {"data":{"enabled":\(enabled),"managed":\(enabled),"forever":false,"since":null,"until":null,"remaining_seconds":null,"battery":null,"sudoers_configured":true,"sudoers_effective":true}}
        """.data(using: .utf8)!
    }

    func testDecodeAwakeStatus() {
        XCTAssertEqual(decodeAwakeStatus(statusJSON(enabled: true))?.enabled, true)
        XCTAssertEqual(decodeAwakeStatus(statusJSON(enabled: false))?.enabled, false)
        XCTAssertNil(decodeAwakeStatus(Data("not json".utf8)))
        XCTAssertNil(decodeAwakeStatus(nil))
    }

    func testParseCLIErrorPrefersMessageAndHint() {
        let blob = """
        {"error":{"code":"setup_required","message":"Passwordless toggling is not configured.","hint":"awake setup"},"data":null}
        """
        XCTAssertEqual(
            parseCLIError(blob),
            "Passwordless toggling is not configured. (awake setup)"
        )
    }

    func testParseCLIErrorFallsBackToTrimmedText() {
        XCTAssertEqual(parseCLIError("  boom  "), "boom")
    }

    func testResolveOutcomePrefersActionReplyButKeepsItsError() {
        let reply = decodeAwakeStatus(statusJSON(enabled: true))
        let fallback = decodeAwakeStatus(statusJSON(enabled: false))
        let outcome = resolveOutcome(
            actionGiven: true,
            actionReply: reply,
            actionError: "boom",
            statusReply: fallback,
            statusError: nil
        )
        XCTAssertEqual(outcome.status?.enabled, true)
        XCTAssertEqual(outcome.error, "boom")
    }

    func testResolveOutcomeFallsBackToStatusReply() {
        let outcome = resolveOutcome(
            actionGiven: true,
            actionReply: nil,
            actionError: nil,
            statusReply: decodeAwakeStatus(statusJSON(enabled: false)),
            statusError: nil
        )
        XCTAssertEqual(outcome.status?.enabled, false)
        XCTAssertNil(outcome.error)
    }

    func testResolveOutcomeRefreshNeverSurfacesStaleErrors() {
        let outcome = resolveOutcome(
            actionGiven: false,
            actionReply: nil,
            actionError: nil,
            statusReply: decodeAwakeStatus(statusJSON(enabled: true)),
            statusError: "stale noise"
        )
        XCTAssertEqual(outcome.status?.enabled, true)
        XCTAssertNil(outcome.error)
    }

    func testResolveOutcomeDoubleFailureFallsBackToGenericHint() {
        let outcome = resolveOutcome(
            actionGiven: true,
            actionReply: nil,
            actionError: nil,
            statusReply: nil,
            statusError: nil
        )
        XCTAssertNil(outcome.status)
        XCTAssertTrue(outcome.error?.contains("awake status --json") ?? false)
    }

    func testQuickResolveNeverSpawnsShells() {
        var probes = 0
        let deps = CLIResolverDeps(
            home: "/Users/test",
            env: [:],
            cliPathDefault: nil,
            fileExists: { _ in false },
            isExecutable: { _ in false },
            shellProbe: { _, _ in probes += 1; return nil },
            now: Date.init
        )
        XCTAssertNil(CLIResolver(deps: deps).quickResolve())
        XCTAssertEqual(probes, 0, "init-time resolution must not spawn login shells")
    }

    func testRefreshManualClearsProbeCache() {
        var probes = 0
        let deps = CLIResolverDeps(
            home: "/Users/test",
            env: [:],
            cliPathDefault: nil,
            fileExists: { _ in false },
            isExecutable: { _ in false },
            shellProbe: { _, _ in probes += 1; return ("/x".data(using: .utf8), 0) },
            now: Date.init
        )
        let r = CLIResolver(deps: deps)
        XCTAssertNil(r.loginShellCliPath()) // miss cached (fileExists false)
        r.clearProbeCache()
        XCTAssertNil(r.loginShellCliPath())
        XCTAssertEqual(probes, 2, "cleared cache must re-probe")
    }
}
