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

The server takes no options or positional arguments: anything else is rejected
instead of being forwarded, so a typo cannot leave an unnoticed server running.
The shim itself sets defaults for OMP_DECK_WEB_DIST, OMP_DECK_STARTER_SKILLS_DIR,
OMP_DECK_STARTER_EXTENSIONS_DIR and OMP_DECK_DEFAULT_CWD; docs/deployment.md
covers the rest.

Environment (most-used; see docs/deployment.md for the full list)
  OMP_DECK_HOST               Bind host                      (default 127.0.0.1)
  OMP_DECK_PORT               HTTP/WebSocket port            (default 8787)
  OMP_DECK_DATA_DIR           deck.db + uploads              (default ~/.omp-deck)
  OMP_DECK_WEB_PORT           Vite dev server port, dev mode (default 5173)

Docs: https://github.com/bjb2/omp-deck
`;

function fail(msg) {
	console.error(`omp-deck: ${msg}`);
	// Exit code rather than process.exit(): stderr must drain when it is a pipe
	// (CI capture), and callers return, so nothing keeps the loop alive.
	process.exitCode = 1;
}

function ensureBun() {
	const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (probe.status === 0 && probe.stdout.toString().trim().length > 0) return true;
	console.error("omp-deck requires Bun (https://bun.sh) — not found on PATH.");
	console.error("");
	console.error("Install:");
	console.error("  curl -fsSL https://bun.sh/install | bash    (macOS / Linux)");
	console.error("  powershell -c \"irm bun.sh/install.ps1 | iex\"  (Windows)");
	console.error("");
	console.error("Then re-run: omp-deck");
	process.exitCode = 127;
	return false;
}

function resolveDataDir() {
	const explicit = process.env.OMP_DECK_DATA_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	return path.join(os.homedir(), ".omp-deck");
}

function main() {
	// Argument handling comes first: `--help`/`--version` must work even when
	// Bun is missing (that is when the install message matters most), and no
	// other input may fall through to a server that ignores it — a stray
	// `--help`, or a dash-less look-alike like `omp-deck help`, used to leave an
	// unattended instance on :8787 with the operator's real home.
	//
	// Nothing here calls process.exit(): these paths `return` instead, so stdout
	// is flushed even when it is a pipe (the CI matrix captures it) and the exit
	// code stays truthful.
	//
	// The policy is deliberately total: nothing consumes arguments (the server
	// only re-execs argv on restart), so anything other than exactly
	// `-h`/`--help`/`-v`/`--version` — positionals, `--`, bare `-` included — is
	// rejected rather than forwarded.
	//
	// Caveat: a bare `--` never reaches this code when the shim is launched by
	// `bun`, because the launcher consumes it before the script sees argv. It is
	// rejected normally under `node`, which is what the npm bin shim uses.
	const args = process.argv.slice(2);
	const unexpected = args.find((arg) => !["-h", "--help", "-v", "--version"].includes(arg));
	if (unexpected !== undefined) {
		console.error(`omp-deck: unexpected argument '${unexpected}'`);
		console.error("The server takes no options or positional arguments. Run `omp-deck --help` for usage.");
		process.exitCode = 2;
		return;
	}
	if (args.includes("-h") || args.includes("--help")) {
		process.stdout.write(USAGE);
		return;
	}
	if (args.includes("-v") || args.includes("--version")) {
		let version;
		try {
			version = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
		} catch (err) {
			fail(`cannot read package.json: ${err.message}`);
			return;
		}
		process.stdout.write(`${version}\n`);
		return;
	}

	if (!existsSync(SERVER_ENTRY)) {
		fail(`server entry missing at ${SERVER_ENTRY} — broken install?`);
		return;
	}
	if (!ensureBun()) return;

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
