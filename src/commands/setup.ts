import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { Command } from "commander";
import {
  SUDOERS_FILE,
  checkRuleEffective,
  hasSudoTimestamp,
  installSudoersRule,
  isSudoersConfigured,
  sudoersRule,
  uninstallSudoersRule,
} from "../system/sudoers.js";
import {
  type GlobalFlags,
  resolveFormat,
} from "../output/formatter.js";
import { printJson } from "../output/json.js";
import { isTTY } from "../utils/env.js";
import { CLIError, handleError } from "../utils/errors.js";
import { requireMacOS } from "../utils/platform.js";

export interface SetupInputs {
  check: boolean;
  verify: boolean;
  uninstall: boolean;
  configured: boolean;
  effective: boolean;
  isTTY: boolean;
  hasTimestamp: boolean;
}

export type SetupAction =
  | { kind: "uninstall" }
  | { kind: "uninstall-needs-tty" }
  | { kind: "probe" }
  | { kind: "noop" }
  | { kind: "install"; repair: boolean }
  | { kind: "needs-tty" };

// Pure state machine for `awake setup` (unit-tested in setup.test.ts):
// every flag/mode combination maps to exactly one action, so the async
// handler below is just I/O around this decision.
export function resolveSetupAction(s: SetupInputs): SetupAction {
  if (s.uninstall)
    return s.isTTY || s.hasTimestamp ? { kind: "uninstall" } : { kind: "uninstall-needs-tty" };
  if (s.check || s.verify) return { kind: "probe" };
  if (s.configured && s.effective) return { kind: "noop" };
  if (!s.isTTY) return { kind: "needs-tty" };
  return { kind: "install", repair: s.configured };
}

export function createSetupCommand(): Command {
  const cmd = new Command("setup")
    .description("One-time setup: authorize passwordless sleep toggling")
    .option("--check", "Liveness probe, no password: exit 0 only when the rule is honored")
    .option("--verify", "Passwordless liveness probe: is the rule honored? exit 0/3")
    .option("--uninstall", "Remove the sudoers rule installed by setup")
    .addHelpText(
      "after",
      `
Setup installs ${SUDOERS_FILE} so awake can run exactly these two commands
without a password prompt (and nothing else):

  pmset -a disablesleep 1
  pmset -a disablesleep 0

On stock macOS it also appends one line to /etc/sudoers so sudo reads the
drop-in directory (backed up first, validated with visudo, auto-reverted
on failure):

  #includedir /private/etc/sudoers.d

Renaming your account or switching users needs a re-run. --uninstall
removes the drop-in file but leaves that (harmless) include line in place.
Run setup as yourself, not under sudo (SUDO_USER is honored if you do).

Every setup --json reply carries the same four keys:
  {configured, effective, repaired, warning}
--check/--verify (pure probes, never mutate) use the {configured, effective}
subset; --uninstall adds {uninstalled:true}. --check exits 0 only when the
rule is live, 3 otherwise.
Pass exactly one flag: when combined, --uninstall is honored first and the
probes are skipped.

Examples:
  awake setup              # interactive, asks for your password once
  awake setup --check      # live? exit 0/3 (same probe as --verify)
  awake setup --verify     # is the rule live? exit 0/3
  awake setup --uninstall  # remove the rule`,
    )
    .action(async (opts: { check?: boolean; verify?: boolean; uninstall?: boolean }) => {
      const globals = cmd.parent?.opts() as GlobalFlags;
      const format = resolveFormat(globals);

      try {
        requireMacOS();
        const configured = isSudoersConfigured();
        const tty = isTTY();
        const probing = Boolean(opts.check || opts.verify);
        // Liveness is only needed for the install/noop decision; probes
        // compute it themselves in their own branch.
        const effective =
          configured && !opts.uninstall && !probing ? await checkRuleEffective() : false;
        const hasTimestamp = Boolean(opts.uninstall) && !tty ? await hasSudoTimestamp() : false;
        const action = resolveSetupAction({
          check: Boolean(opts.check),
          verify: Boolean(opts.verify),
          uninstall: Boolean(opts.uninstall),
          configured,
          effective,
          isTTY: tty,
          hasTimestamp,
        });

        if (action.kind === "uninstall-needs-tty") {
          throw new CLIError(
            "Uninstall needs sudo; without a terminal it requires a cached timestamp (run `sudo -v` first).",
            {
              exitCode: 3,
              code: "tty_required",
              hint: "run `awake setup --uninstall` yourself in a terminal",
            },
          );
        }

        if (action.kind === "uninstall") {
          await uninstallSudoersRule();
          if (format === "json") {
            printJson({ configured: false, effective: false, repaired: false, warning: null, uninstalled: true });
          } else {
            console.log(
              `\n  ${chalk.blue("○")} removed the sudoers rule - awake will now require setup again\n`,
            );
          }
          return;
        }

        // --check and --verify are the same liveness probe (two names);
        // neither mutates anything.
        if (action.kind === "probe") {
          const live = await checkRuleEffective();
          if (format === "json") {
            printJson({ configured, effective: live });
          } else if (live) {
            console.log(
              `\n  ${chalk.green("●")} rule is live - toggling works without a password\n`,
            );
          } else if (configured) {
            console.log(
              `\n  ${chalk.yellow("▲")} rule file present but not live - run ${chalk.bold("awake setup")} to repair\n`,
            );
          } else {
            console.log(
              `\n  ${chalk.yellow("▲")} not configured - run ${chalk.bold("awake setup")}\n`,
            );
          }
          // Set the code and return: process.exit() can truncate piped JSON.
          process.exitCode = live ? 0 : 3;
          return;
        }

        if (action.kind === "noop") {
          if (format === "json") {
            printJson({ configured: true, effective: true, repaired: false, warning: null });
          } else {
            console.log(
              `\n  ${chalk.green("●")} already configured - nothing to do\n`,
            );
          }
          return;
        }

        if (action.kind === "needs-tty") {
          throw new CLIError(
            configured
              ? "The sudoers rule is installed but not effective; repair needs an interactive terminal."
              : "Setup needs an interactive terminal to ask for your password once.",
            {
              exitCode: 3,
              code: "tty_required",
              hint: "run `awake setup` yourself in a terminal",
            },
          );
        }

        console.log("");
        console.log(
          configured
            ? `  rule file exists - verifying sudo actually honors it and repairing if not:`
            : `  awake setup will install ${chalk.bold(SUDOERS_FILE)}:`,
        );
        console.log("");
        console.log(chalk.dim(`    ${sudoersRule().trim()}`));
        console.log("");
        console.log(
          "  This allows exactly those two pmset commands to run without a",
        );
        console.log(
          "  password - nothing else gets elevated. You can undo it anytime",
        );
        console.log(`  with ${chalk.bold("awake setup --uninstall")}.`);
        console.log(
          "  On stock macOS this also appends one #includedir line to",
        );
        console.log(
          "  /etc/sudoers (backed up, validated, auto-reverted on failure)",
        );
        console.log("  so sudo reads the drop-in directory.");
        console.log("");

        if (!globals.yes) {
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const answer = await rl.question("  Continue? [y/N] ");
          rl.close();
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log("\n  aborted - nothing was changed\n");
            return;
          }
        }

        console.log("");
        const { repaired, warning } = await installSudoersRule();
        const effectiveAfter = await checkRuleEffective();

        if (format === "json") {
          printJson({ configured: true, effective: effectiveAfter, repaired, warning });
        } else if (warning) {
          console.log(`\n  ${chalk.yellow("▲")} ${warning}\n`);
        } else if (repaired) {
          console.log(
            `\n  ${chalk.green("●")} repaired - try it: ${chalk.bold("awake on 30m")}\n`,
          );
        } else {
          console.log(
            `\n  ${chalk.green("●")} setup complete - try it: ${chalk.bold("awake on 30m")}\n`,
          );
        }
      } catch (error) {
        handleError(error, format);
      }
    });

  return cmd;
}
