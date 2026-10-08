#!/usr/bin/env node
// omp-deck CLI entrypoint.
//
// This is a tiny Node-runnable shim. It checks for Bun on PATH (the deck is a
// Bun-native server) and spawns the bundled server, inheriting stdio + signals
// + exit code. Default data directory is ~/.omp-deck; overridable via
// OMP_DECK_DATA_DIR or the existing OMP_DECK_DB_PATH / OMP_DECK_UPLOADS_ROOT
// env vars. Default web dist is the bundled `apps/web/dist/` shipped in the
// package; overridable via OMP_DECK_WEB_DIST.
//
// Why Node, not Bun: the user may not have Bun yet — we want to print an
// actionable install message instead of an ENOENT.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Package root is the directory containing `bin/`.
const PKG_ROOT = path.resolve(HERE, "..");
const SERVER_ENTRY = path.join(PKG_ROOT, "apps", "server", "src", "index.ts");
const WEB_DIST = path.join(PKG_ROOT, "apps", "web", "dist");
const STARTER_SKILLS = path.join(PKG_ROOT, "starter-skills");
const STARTER_EXTENSIONS = path.join(PKG_ROOT, "starter-extensions");

const USAGE = `omp-deck — local web cockpit for the omp (oh-my-pi) coding agent

Usage
  omp-deck                    Start the server (loopback by default)
  omp-deck --help             Show this message
  omp-deck --version          Print the version

The server takes no flags: an unrecognized option is rejected instead of being
forwarded, so a typo cannot leave an unnoticed server running.

Environment (most-used; see docs/deployment.md for the full list)
  OMP_DECK_HOST               Bind host                      (default 127.0.0.1)
  OMP_DECK_PORT               HTTP/WebSocket port            (default 8787)
  OMP_DECK_DATA_DIR           deck.db + uploads              (default ~/.omp-deck)
  OMP_DECK_ALLOWED_ORIGINS    Extra browser origins allowed to call the API
  OMP_DECK_WEB_PORT           Vite dev server port, dev mode (default 5173)

Docs: https://github.com/bjb2/omp-deck
`;

function fail(msg) {
	console.error(`omp-deck: ${msg}`);
	process.exit(1);
}

function ensureBun() {
	const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (probe.status === 0 && probe.stdout.toString().trim().length > 0) return;
	console.error("omp-deck requires Bun (https://bun.sh) — not found on PATH.");
	console.error("");
	console.error("Install:");
	console.error("  curl -fsSL https://bun.sh/install | bash    (macOS / Linux)");
	console.error("  powershell -c \"irm bun.sh/install.ps1 | iex\"  (Windows)");
	console.error("");
	console.error("Then re-run: omp-deck");
	process.exit(127);
}

function resolveDataDir() {
	const explicit = process.env.OMP_DECK_DATA_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	return path.join(os.homedir(), ".omp-deck");
}

function main() {
	// Argument handling comes first: `--help`/`--version` must work even when
	// Bun is missing (that is when the install message matters most), and an
	// unknown flag must not fall through to a server that ignores it — that is
	// how a stray `--help` ended up leaving an unattended instance on :8787.
	const args = process.argv.slice(2);
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(USAGE);
			process.exit(0);
		}
		if (arg === "-v" || arg === "--version") {
			const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
			process.stdout.write(`${pkg.version}\n`);
			process.exit(0);
		}
		if (arg.startsWith("-")) {
			console.error(`omp-deck: unknown option '${arg}'`);
			console.error("Run `omp-deck --help` for usage.");
			process.exit(2);
		}
	}

	if (!existsSync(SERVER_ENTRY)) {
		fail(`server entry missing at ${SERVER_ENTRY} — broken install?`);
	}
	ensureBun();

	const dataDir = resolveDataDir();
	mkdirSync(dataDir, { recursive: true });

	const env = { ...process.env };
	// Only set defaults — let user overrides win.
	env.OMP_DECK_DB_PATH ??= path.join(dataDir, "deck.db");
	env.OMP_DECK_UPLOADS_ROOT ??= path.join(dataDir, "uploads");
	env.OMP_DECK_WEB_DIST ??= WEB_DIST;
	env.OMP_DECK_STARTER_SKILLS_DIR ??= STARTER_SKILLS;
	env.OMP_DECK_STARTER_EXTENSIONS_DIR ??= STARTER_EXTENSIONS;
	// Default cwd: the data dir, not wherever the user happened to invoke from.
	// The agent's own session cwd is independent and still defaults to $HOME.
	env.OMP_DECK_DEFAULT_CWD ??= os.homedir();

	const child = spawn("bun", [SERVER_ENTRY, ...args], {
		stdio: "inherit",
		env,
		// Bun resolves relative imports against the script path; cwd here only
		// influences where Bun looks for bunfig.toml — keep it at package root
		// so workspace settings (if any) apply.
		cwd: PKG_ROOT,
	});

	function forward(sig) {
		try {
			child.kill(sig);
		} catch {
			/* child already exited */
		}
	}
	process.on("SIGINT", () => forward("SIGINT"));
	process.on("SIGTERM", () => forward("SIGTERM"));

	child.on("exit", (code, signal) => {
		if (signal) {
			// Re-raise the signal in this process so the parent shell sees it.
			process.kill(process.pid, signal);
		} else {
			process.exit(code ?? 0);
		}
	});
	child.on("error", (err) => {
		fail(`failed to spawn bun: ${err.message}`);
	});
}

main();
