import Foundation
@preconcurrency import UserNotifications

struct BatteryInfo: Decodable {
    let percent: Int?
    let onAc: Bool
    let charging: Bool
}

struct AwakeStatus: Decodable {
    let enabled: Bool
    let managed: Bool
    let forever: Bool
    let since: String?
    let until: String?
    let remainingSeconds: Int?
    let battery: BatteryInfo?
    let sudoersConfigured: Bool?
    let sudoersEffective: Bool?

    static let initial = AwakeStatus(
        enabled: false, managed: false, forever: false,
        since: nil, until: nil, remainingSeconds: nil,
        battery: nil, sudoersConfigured: nil, sudoersEffective: nil
    )

    var untilDate: Date? {
        guard let until else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: until)
    }
}

// Injectable seams for the CLI-resolution policy (see Tests/):
// production uses `.live`. Probe results are cached briefly so
// version-manager users don't pay for login shells on every tick.
struct CLIResolverDeps {
    var home: String
    var env: [String: String]
    var cliPathDefault: String?
    var fileExists: (String) -> Bool
    var isExecutable: (String) -> Bool
    var shellProbe: (String, String) -> (Data?, Int32)?
    var now: () -> Date

    static var live: CLIResolverDeps {
        let fm = FileManager.default
        return CLIResolverDeps(
            home: fm.homeDirectoryForCurrentUser.path,
            env: ProcessInfo.processInfo.environment,
            cliPathDefault: UserDefaults.standard.string(forKey: "cliPath"),
            fileExists: { fm.fileExists(atPath: $0) },
            isExecutable: { fm.isExecutableFile(atPath: $0) },
            shellProbe: { shell, command in
                let result = CLIResolver.execute([shell, "-l", "-c", command], timeout: 10)
                guard result.code == 0 else { return nil }
                return (result.stdout, result.code)
            },
            now: Date.init
        )
    }
}

// The CLI ships as a JS entrypoint whose `env node` shebang is useless in
// a GUI context (nvm/bun PATHs live in shell rc files), so resolve the
// symlink and pair it with a runtime found at a known location.
// Precedence: explicit override (AWAKE_CLI env or `cliPath` default) >
// well-known install dirs > the user's login-shell PATH (covers nvm,
// fnm, volta, asdf, MacPorts, custom npm prefixes).
// Set an override with:
//   defaults write com.crafterstation.awake.menubar cliPath /path/to/awake
final class CLIResolver {
    static let live = CLIResolver(deps: .live)
    static let probeTTL: TimeInterval = 300
    static let executeTimeout: TimeInterval = 20

    private let deps: CLIResolverDeps
    private let lock = NSLock()
    private var probeCache: [String: (String?, Date)] = [:]

    init(deps: CLIResolverDeps) { self.deps = deps }

    func cliCandidates() -> [String] {
        [
            "\(deps.home)/.bun/bin/awake",
            "/opt/homebrew/bin/awake",
            "/usr/local/bin/awake",
            "/opt/local/bin/awake",
        ]
    }

    func pairRuntimeNoProbe(cli: String) -> [String]? {
        pairRuntime(cli: cli, allowProbes: false)
    }

    func resolveInvocation() -> [String]? {
        if let env = deps.env["AWAKE_CLI"],
           deps.fileExists(env), let inv = pairRuntime(cli: env) {
            return inv
        }
        if let ud = deps.cliPathDefault,
           deps.fileExists(ud), let inv = pairRuntime(cli: ud) {
            return inv
        }
        // Try every candidate: the first-found CLI is useless if its
        // runtime can't be paired, and a later one may work.
        for cli in cliCandidates() where deps.fileExists(cli) {
            if let inv = pairRuntime(cli: cli) { return inv }
        }
        if let probed = loginShellCliPath(), let inv = pairRuntime(cli: probed) {
            return inv
        }
        return nil
    }

    func pairRuntime(cli: String, allowProbes: Bool = true) -> [String]? {
        let resolved = URL(fileURLWithPath: cli).resolvingSymlinksInPath().path
        guard resolved.hasSuffix(".js") else { return [resolved] }
        let runtimeCandidates = [
            "\(deps.home)/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
            "/opt/local/bin/bun",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/opt/local/bin/node",
        ]
        if let runtime = runtimeCandidates.first(where: deps.isExecutable) {
            return [runtime, resolved]
        }
        // Version-manager installs (nvm/fnm/volta/asdf) live outside every
        // well-known dir: ask the login shell where its runtime is.
        guard allowProbes else { return nil }
        for tool in ["bun", "node"] {
            if let runtime = loginShellProbe("command -v \(tool)"),
               deps.isExecutable(runtime) {
                return [runtime, resolved]
            }
        }
        return nil
    }

    // The user's login shell: stock macOS defaults to zsh, and version
    // managers configure PATH in ~/.zprofile-style files that bash-as-sh
    // never sources. $SHELL first, zsh second, /bin/sh last resort.
    // Probe-free resolution for launch/init: login shells can take
    // seconds (slow rc files), which would jank the main thread. The first
    // background refresh upgrades to the full lookup automatically.
    func quickResolve() -> [String]? {
        if let env = deps.env["AWAKE_CLI"],
           deps.fileExists(env), let inv = pairRuntimeNoProbe(cli: env) {
            return inv
        }
        if let ud = deps.cliPathDefault,
           deps.fileExists(ud), let inv = pairRuntimeNoProbe(cli: ud) {
            return inv
        }
        for cli in cliCandidates() where deps.fileExists(cli) {
            if let inv = pairRuntimeNoProbe(cli: cli) { return inv }
        }
        return nil
    }

    func loginShells() -> [String] {
        var shells: [String] = []
        if let sh = deps.env["SHELL"], !sh.isEmpty, deps.isExecutable(sh) {
            shells.append(sh)
        }
        for fallback in ["/bin/zsh", "/bin/sh"] where !shells.contains(fallback) {
            shells.append(fallback)
        }
        return shells
    }

    func loginShellCliPath() -> String? {
        guard let path = loginShellProbe("command -v awake"),
              deps.fileExists(path) else { return nil }
        return path
    }

    func clearProbeCache() {
        lock.lock()
        probeCache.removeAll()
        lock.unlock()
    }

    func loginShellProbe(_ command: String) -> String? {
        lock.lock()
        if let (cached, at) = probeCache[command],
           deps.now().timeIntervalSince(at) < Self.probeTTL {
            lock.unlock()
            return cached
        }
        lock.unlock()
        var found: String?
        for shell in loginShells() {
            guard let (data, code) = deps.shellProbe(shell, command), code == 0,
                  let out = data else { continue }
            let path = String(data: out, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !path.isEmpty { found = path; break }
        }
        lock.lock()
        probeCache[command] = (found, deps.now())
        lock.unlock()
        return found
    }

    // Both pipes drain concurrently (serial reads risk wedging if a future
    // CLI writes heavily to stderr), stdin is detached so a GUI-spawned
    // child can never block on input, and a hung child is SIGTERMed then
    // SIGKILLed.
    nonisolated static func execute(_ argv: [String], timeout: TimeInterval = executeTimeout) -> (stdout: Data?, stderr: String?, code: Int32) {
        guard let first = argv.first else { return (nil, "no command", 1) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: first)
        process.arguments = Array(argv.dropFirst())
        process.standardInput = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            return (nil, "could not launch \(first): \(error.localizedDescription)", 1)
        }
        final class Box: @unchecked Sendable { var data = Data() }
        let outBox = Box()
        let errBox = Box()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            outBox.data = stdout.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errBox.data = stderr.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if group.wait(timeout: .now() + timeout) != .success {
            process.terminate()
            Thread.sleep(forTimeInterval: 2)
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            return (nil, "awake CLI timed out after \(Int(timeout))s", 124)
        }
        process.waitUntilExit()
        let errString = String(data: errBox.data, encoding: .utf8)
        return (outBox.data, errString, process.terminationStatus)
    }
}

private struct Envelope<T: Decodable>: Decodable {
    let data: T?
}

private struct CLIErrorBody: Decodable {
    let message: String?
    let hint: String?
}

private struct CLIErrorEnvelope: Decodable {
    let error: CLIErrorBody?
}

// Pure response policy (unit-tested in ResolverTests.swift): no Process,
// no MainActor, no singletons.
func makeStatusDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return decoder
}

func decodeAwakeStatus(_ output: Data?, decoder: JSONDecoder = makeStatusDecoder()) -> AwakeStatus? {
    output.flatMap {
        try? decoder.decode(Envelope<AwakeStatus>.self, from: $0).data
    }
}

// CLI failures arrive as a JSON error envelope on stderr; show its
// message/hint instead of the raw blob.
func parseCLIError(_ output: String, decoder: JSONDecoder = makeStatusDecoder()) -> String {
    if let data = output.data(using: .utf8),
       let body = try? decoder.decode(CLIErrorEnvelope.self, from: data).error,
       let message = body.message {
        if let hint = body.hint, !hint.isEmpty { return "\(message) (\(hint))" }
        return message
    }
    return output.trimmingCharacters(in: .whitespacesAndNewlines)
}

// Pure outcome reduction (unit-tested): which status to show and which
// error, if any. A failed action stays visible even when the fallback
// status succeeds; a clean refresh never surfaces stale errors.
func resolveOutcome(
    actionGiven: Bool,
    actionReply: AwakeStatus?,
    actionError: String?,
    statusReply: AwakeStatus?,
    statusError: String?
) -> (status: AwakeStatus?, error: String?) {
    if let actionReply { return (actionReply, actionError) }
    if let statusReply { return (statusReply, actionGiven ? actionError : nil) }
    return (
        nil,
        actionError ?? statusError
            ?? "the awake CLI produced no usable output - try `awake status --json` in a terminal"
    )
}

@MainActor
final class AwakeModel: ObservableObject {
    @Published var status: AwakeStatus = .initial
    @Published var cliFound: Bool
    @Published var lastError: String?
    @Published var lastChecked: Date?
    // False until the first poll completes: avoids flashing a healthy
    // "Off" while the true state is still unknown.
    @Published var loaded = false

    private var timer: Timer?

    init() {
        // Resolve lazily on every action, not once at launch: the CLI
        // may be linked (or fixed) after this app is already running.
        // A launch-time-only resolve turns that into permanently dead buttons.
        // Cheap paths only here (no login-shell probes): a slow rc file
        // must never jank launch. The first background tick upgrades this.
        cliFound = CLIResolver.live.quickResolve() != nil
        refresh()
        // Poll briskly: CLI and app share state only through pmset/the state
        // file, so a short interval is what makes CLI-side changes feel live.
        // One lightweight `status --json` subprocess per tick is negligible.
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() { perform(nil, userInitiated: false) }

    // Manual Refresh bypasses the probe cache: installing the CLI and
    // pressing Refresh must work immediately, not after the TTL expires.
    func refreshManual() {
        CLIResolver.live.clearProbeCache()
        refresh()
    }
    func turnOn(_ duration: String) { perform(["on", duration, "--json"], userInitiated: true) }
    func turnOnForever() { perform(["on", "--forever", "--json"], userInitiated: true) }
    func turnOff() { perform(["off", "--json"], userInitiated: true) }

    // Action commands (on/off) now return the same JSON shape as `status`,
    // so decode that reply directly instead of always following up with a
    // separate `status --json` call - halves the subprocesses per click.
    // Falls back to an explicit status call only if the action's own reply
    // didn't decode (e.g. it errored and wrote to stderr instead).
    // Guards overlapping polls: a second tick/action while one CLI call is
    // still running is dropped instead of piling up subprocesses whose
    // out-of-order replies could flash stale status.
    private var inFlight = false

    private func perform(_ action: [String]?, userInitiated: Bool) {
        guard !inFlight else {
            NSLog("AwakeBar: skipping overlapping action")
            // Polls drop silently; a tapped button must say so.
            if userInitiated { lastError = "awake is busy - try again in a moment" }
            return
        }
        inFlight = true
        Task.detached(priority: .userInitiated) { [weak self] in
            guard let invocation = CLIResolver.live.resolveInvocation() else {
                await MainActor.run { [weak self] in
                    self?.inFlight = false
                    self?.cliFound = false
                    self?.lastError = "awake CLI not found (checked AWAKE_CLI, the cliPath default, ~/.bun/bin, Homebrew, /usr/local, /opt/local, and your login PATH). Install it or set an override, then press Refresh."
                }
                NSLog("AwakeBar: CLI not found")
                return
            }

            // Keep the action's own failure even when the fallback status
            // succeeds - otherwise a failed `on` looks identical to "still off".
            // Status-call diagnostics are kept too (for logs/hints), but a
            // failed refresh never overwrites the last good error line.
            var actionError: String?
            var actionCode: Int32 = 0
            var statusStderr: String?
            var statusCode: Int32 = 0
            func run(_ args: [String], isAction: Bool) -> AwakeStatus? {
                let result = CLIResolver.execute(invocation + args)
                if isAction {
                    actionCode = result.code
                    if result.code != 0, let err = result.stderr, !err.isEmpty {
                        actionError = parseCLIError(err)
                    }
                } else {
                    statusCode = result.code
                    statusStderr = result.stderr
                }
                return decodeAwakeStatus(result.stdout)
            }

            // Prefer the action's own reply; fall back to an explicit status
            // call only when it didn't decode - a successful action never
            // pays for a second subprocess.
            let actionReply: AwakeStatus? = action != nil ? run(action!, isAction: true) : nil
            let statusReply: AwakeStatus? = actionReply == nil ? run(["status", "--json"], isAction: false) : nil
            let parsedStatusError: String? = statusStderr.flatMap { $0.isEmpty ? nil : parseCLIError($0) }
            let outcome = resolveOutcome(
                actionGiven: action != nil,
                actionReply: actionReply,
                actionError: actionError,
                statusReply: statusReply,
                statusError: parsedStatusError
            )

            await MainActor.run { [weak self] in
                guard let self else { return }
                self.inFlight = false
                self.cliFound = true
                self.lastChecked = Date()
                self.loaded = true
                if let status = outcome.status {
                    self.status = status
                    // Surface a failed action instead of silently showing
                    // the (unchanged) fallback status.
                    self.lastError = outcome.error
                    self.updateReminder(for: status)
                } else {
                    self.lastError = outcome.error
                }
                NSLog("AwakeBar: action=%@ exit=%d sExit=%d decoded=%@ err=%@", action?.joined(separator: " ") ?? "(status)", actionCode, statusCode, outcome.status != nil ? "yes" : "no", outcome.error ?? "-")
            }
        }
    }

    // A repeating "still on" nudge, only for forever mode - timed sessions
    // already auto-off and notify from the CLI side.
    private func updateReminder(for status: AwakeStatus) {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        let identifier = "awake.reminder"

        guard status.enabled, status.forever else {
            center.removePendingNotificationRequests(withIdentifiers: [identifier])
            return
        }

        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            center.getPendingNotificationRequests { pending in
                guard !pending.contains(where: { $0.identifier == identifier }) else { return }
                let content = UNMutableNotificationContent()
                content.title = "Awake is still on"
                content.body = "Your Mac is being kept awake with no timer. Turn it off from the menu bar when you are done."
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 3600, repeats: true)
                center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
            }
        }
    }

    var statusLine: String {
        if !status.enabled {
            return "Off - closing the lid sleeps normally"
        }
        if status.forever {
            return "On until you turn it off"
        }
        if let until = status.untilDate {
            return "On - auto-off at \(Self.timeFormatter.string(from: until))"
        }
        return "On"
    }

    var menuBarCountdown: String? {
        guard status.enabled, !status.forever, let until = status.untilDate else {
            return nil
        }
        let minutes = Int(max(0, until.timeIntervalSinceNow) / 60)
        if minutes >= 60 {
            return "\(minutes / 60)h \(minutes % 60)m"
        }
        return "\(minutes)m"
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()
}
