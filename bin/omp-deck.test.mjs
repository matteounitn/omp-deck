// CLI surface tests for bin/omp-deck.mjs.
//
// These run the shim the way a user does, because the bug they guard against is
// behavioural: `--help` used to spawn the server and leave it listening, and so
// did any unrecognized token — a typo, a dash-less `help`, a Windows-style `/?`.
//
// Run from the repo root (`bun test`), which is what the CI matrix does:
// `*.test.mjs` is discovered there (verified by counting tests with the file
// present vs. moved away).
//
// Cases that spawn several shim processes carry an explicit 30s timeout so a
// slow CI leg cannot turn them into flakes.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.join(import.meta.dir, "omp-deck.mjs");
const PKG = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"));
/** Wide random band so a parallel CI leg is unlikely to sit on the probe port. */
const PORT = 20000 + Math.floor(Math.random() * 40000);
const TMP = mkdtempSync(path.join(os.tmpdir(), "omp-deck-cli-"));

/** Profile roots the shim or the server would otherwise inherit from the ambient env. */
const ISOLATED_KEYS = [
	"OMP_AGENT_DIR",
	"OMP_DECK_DB_PATH",
	"OMP_DECK_DB",
	"OMP_DECK_UPLOADS_ROOT",
	"OMP_DECK_KB_ROOT",
	"OMP_DECK_DEFAULT_CWD",
	"OMP_DECK_WEB_DIST",
	"OMP_DECK_STARTER_SKILLS_DIR",
	"OMP_DECK_STARTER_EXTENSIONS_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"LOCALAPPDATA",
];

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Child env with ambient profile roots removed and a throwaway home. */
function childEnv(extra = {}) {
	const env = { ...process.env, HOME: TMP, USERPROFILE: TMP, ...extra };
	for (const key of ISOLATED_KEYS) delete env[key];
	return env;
}

/** Runs the shim against a throwaway profile: temp home, temp data dir, probe port. */
function run(...args) {
	return spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		timeout: 15_000,
		env: childEnv({
			OMP_DECK_DATA_DIR: path.join(TMP, "data"),
			OMP_DECK_HOST: "127.0.0.1",
			OMP_DECK_PORT: String(PORT),
		}),
	});
}

function connectOnce() {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: PORT });
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
		socket.setTimeout(1000, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

/** Retries for ~2s so a regression that boots the server slowly is still caught. */
async function listening() {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		if (await connectOnce()) return true;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

describe("omp-deck CLI arguments", () => {
	it(
		"--help prints usage, exits cleanly and starts nothing",
		async () => {
			const res = run("--help");
			expect(res.status).toBe(0);
			expect(res.signal).toBeNull();
			expect(res.stdout).toContain("Usage");
			expect(res.stdout).toContain("OMP_DECK_PORT");
			expect(res.stdout).toContain("--version");
			expect(await listening()).toBe(false);
		},
		30_000,
	);

	it("-h behaves like --help, and --help wins when both are present", () => {
		const short = run("-h");
		expect(short.status).toBe(0);
		expect(short.stdout).toContain("Usage");

		const both = run("--version", "--help");
		expect(both.status).toBe(0);
		expect(both.stdout).toContain("Usage");
	});

	it("--version prints the package version without a signal", () => {
		const res = run("--version");
		expect(res.status).toBe(0);
		expect(res.signal).toBeNull();
		expect(res.stdout.trim()).toBe(PKG.version);
	});

	it(
		"rejects an unknown flag instead of forwarding it to the server",
		async () => {
			const res = run("--nope");
			expect(res.status).toBe(2);
			expect(res.stderr).toContain("unexpected argument '--nope'");
			expect(res.stderr).toContain("omp-deck --help");
			expect(await listening()).toBe(false);
		},
		30_000,
	);

	// `--` is deliberately absent: the `bun` launcher consumes a bare `--`
	// before the script runs, so the shim cannot see it. Under node (the runtime
	// the npm bin shim uses) the token arrives and is rejected with exit 2 —
	// verified by running `node bin/omp-deck.mjs --`. Everything the shim can
	// observe is asserted here.
	it(
		"rejects dash-less look-alikes and separators (the #18 failure class)",
		async () => {
			for (const arg of ["help", "start", "/?", "-", "--help=1", "-hv", ""]) {
				const res = run(arg);
				expect(res.status).toBe(2);
				expect(res.stderr).toContain("unexpected argument");
			}
			expect(await listening()).toBe(false);
		},
		30_000,
	);

	it("rejects an unknown token even alongside --help", () => {
		expect(run("--help", "--nope").status).toBe(2);
		expect(run("--nope", "--help").status).toBe(2);
	});

	// The published entrypoint runs under **node** (npm's bin shim), while the
	// suite's other cases use `process.execPath` — bun during `bun test`. That
	// difference is exactly where a bare `--` diverges: the bun launcher removes
	// it before the script sees argv, node passes it through and the shim
	// rejects it. Guarded so the suite still runs on a machine without node.
	const hasNode =
		spawnSync(process.platform === "win32" ? "where" : "which", ["node"], {
			stdio: ["ignore", "pipe", "ignore"],
		}).status === 0;
	if (hasNode) {
		it(
			"under node: --help works and a bare `--` is rejected",
			() => {
				const help = spawnSync("node", [CLI, "--help"], { encoding: "utf8", timeout: 15_000, env: childEnv() });
				expect(help.status).toBe(0);
				expect(help.stdout).toContain("Usage");

				const separator = spawnSync("node", [CLI, "--"], { encoding: "utf8", timeout: 15_000, env: childEnv() });
				expect(separator.status).toBe(2);
				expect(separator.stderr).toContain("unexpected argument '--'");
			},
			30_000,
		);
	}

	it("never creates the data dir on a non-serving run", () => {
		expect(existsSync(path.join(TMP, "data"))).toBe(false);
	});

	if (process.platform !== "win32") {
		it(
			"a normal run without bun on PATH fails with exit 127 and starts nothing",
			async () => {
				const res = spawnSync(process.execPath, [CLI], {
					encoding: "utf8",
					timeout: 15_000,
					env: childEnv({ PATH: TMP, OMP_DECK_PORT: String(PORT) }),
				});
				expect(res.status).toBe(127);
				expect(res.stderr).toContain("requires Bun");
				expect(await listening()).toBe(false);
			},
			30_000,
		);

		it(
			"--help and --version work without bun on PATH",
			() => {
				for (const arg of ["--help", "--version"]) {
					const res = spawnSync(process.execPath, [CLI, arg], {
						encoding: "utf8",
						timeout: 15_000,
						env: childEnv({ PATH: TMP }),
					});
					expect(res.status).toBe(0);
					expect(res.stdout.length).toBeGreaterThan(0);
				}
			},
			60_000,
		);
	}
});
