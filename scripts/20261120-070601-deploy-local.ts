// =====================================================================================================
// scripts/20261120-070601-deploy-local.ts — build and install this checkout into the local Decky
// =====================================================================================================
// Personal helper for "Pause Game on Menu" on the Legion Go S (SteamOS). Run it ON the Go S, in a
// terminal, from anywhere:   node ~/dev/decky-pause-game-on-menu/scripts/20261120-070601-deploy-local.ts
//
// What it does, in order:
//   1. `pnpm run build` (frontend → dist/index.js).
//   2. Copies the runtime files (plugin.json, package.json, main.py, LICENSE, README.md, dist/) into
//      ~/homebrew/plugins/decky-pause-game-on-menu with `sudo rsync` (--delete keeps it an exact copy).
//      sudo is needed because Decky keeps ~/homebrew/plugins root-owned; it asks for the deck
//      password once (sudo caches it for the next command).
//   3. Restarts Decky (`sudo systemctl restart plugin_loader`) — Decky doesn't live-reload plugins.
//      Skip with --no-restart.
//
// Requirements: Node 23.6+ (TypeScript stripping) and pnpm in PATH (~/.local/bin), rsync, sudo.
// Undo: `sudo rm -r ~/homebrew/plugins/decky-pause-game-on-menu && sudo systemctl restart plugin_loader`
// =====================================================================================================

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(homedir(), "homebrew", "plugins", "decky-pause-game-on-menu");
const RUNTIME_FILES = ["plugin.json", "package.json", "main.py", "LICENSE", "README.md", "dist"];

const run = (cmd: string, args: string[]) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  try { execFileSync(cmd, args, { cwd: REPO, stdio: "inherit" }); }
  catch { console.error(`✗ ${cmd} failed`); process.exit(1); }
};

run("pnpm", ["run", "build"]);
run("sudo", ["mkdir", "-p", TARGET]);
run("sudo", ["rsync", "-a", "--delete", "--exclude", "__pycache__", ...RUNTIME_FILES, `${TARGET}/`]);

if (process.argv.includes("--no-restart")) {
  console.log("✓ Copied. Restart Decky yourself: sudo systemctl restart plugin_loader");
} else {
  run("sudo", ["systemctl", "restart", "plugin_loader"]);
  console.log("✓ Deployed. Log: ~/homebrew/logs/decky-pause-game-on-menu/");
}
