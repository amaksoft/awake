import AppKit
import SwiftUI

struct AwakeMenu: View {
    @ObservedObject var model: AwakeModel

    var body: some View {
        if model.loaded {
            Text(model.statusLine)
        } else {
            Text("Checking status…")
        }
        Divider()

        if model.status.enabled {
            Button("Turn off") { model.turnOff() }
            Divider()
            Section("Restart timer") {
                durationButtons
            }
        } else {
            durationButtons
        }

        Divider()

        if !model.cliFound {
            Text("awake CLI not found")
            Text("Install it, then press Refresh (a new shell PATH needs a relaunch)")
            Divider()
        } else if model.status.sudoersConfigured == false {
            Text("Run `awake setup` in a terminal first")
            Divider()
        } else if model.status.sudoersEffective == false {
            Text("Rule ignored by sudo - run `awake setup` to repair")
            Divider()
        }

        if let error = model.lastError {
            Text(error)
            Divider()
        }

        if let checked = model.lastChecked {
            Text("Last checked \(Self.checkFormatter.string(from: checked))")
        }

        Button("Refresh status") { model.refreshManual() }
        Button("Quit Awake") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }

    private static let checkFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .medium
        formatter.dateStyle = .none
        return formatter
    }()

    @ViewBuilder
    private var durationButtons: some View {
        Button("Keep awake 30 min") { model.turnOn("30m") }
        Button("Keep awake 1 hour") { model.turnOn("1h") }
        Button("Keep awake 2 hours") { model.turnOn("2h") }
        Button("Keep awake 4 hours") { model.turnOn("4h") }
        Button("Keep awake 8 hours") { model.turnOn("8h") }
        Button("Keep awake until turned off") { model.turnOnForever() }
    }
}
