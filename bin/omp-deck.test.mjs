// CLI surface tests for bin/omp-deck.mjs.
//
// These run the shim the way a user does, because the bug they guard against is
// behavioural: `--help` used to spawn the server and leave it listening on the
// default port, and an unknown flag was forwarded to a server that ignores it.
//
// Run from the repo root (`bun test`), which is what the CI matrix does.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.join(import.meta.dir, "omp-deck.mjs");
const PKG = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"));
/** Random high port so a parallel CI job on the same runner cannot collide. */
const PORT = 18900 + Math.floor(Math.random() * 90);
const TMP = mkdtempSync(path.join(os.tmpdir(), "omp-deck-cli-"));

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Runs the shim against a throwaway profile: temp HOME, temp data dir, closed port. */
function run(...args) {
	return spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		timeout: 15_000,
		env: {
			...process.env,
			HOME: TMP,
			USERPROFILE: TMP,
			OMP_DECK_DATA_DIR: path.join(TMP, "data"),
			OMP_DECK_HOST: "127.0.0.1",
			OMP_DECK_PORT: String(PORT),
		},
	});
}

/** Resolves true when something is listening — i.e. the command started a server. */
function listening() {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: PORT });
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
		socket.setTimeout(1500, () => {
			socket.destroy();
			resolve(false);
		});
	});
}

describe("omp-deck CLI arguments", () => {
	it("--help prints usage, exits 0 and starts nothing", async () => {
		const res = run("--help");
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("Usage");
		expect(res.stdout).toContain("OMP_DECK_PORT");
		expect(res.stdout).toContain("--version");
		expect(await listening()).toBe(false);
	});

	it("-h behaves like --help", () => {
		const res = run("-h");
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("Usage");
	});

	it("--version prints the package version", () => {
		const res = run("--version");
		expect(res.status).toBe(0);
		expect(res.stdout.trim()).toBe(PKG.version);
	});

	it("rejects an unknown flag instead of forwarding it to the server", async () => {
		const res = run("--nope");
		expect(res.status).toBe(2);
		expect(res.stderr).toContain("unknown option '--nope'");
		expect(res.stderr).toContain("omp-deck --help");
		expect(await listening()).toBe(false);
	});

	it("never creates the data dir on a help/version/typo run", () => {
		expect(existsSync(path.join(TMP, "data"))).toBe(false);
	});

	// The shim exists so a user without Bun gets the install message; --help must
	// therefore not depend on Bun being on PATH. Windows PATH handling differs,
	// so the case is POSIX-only.
	if (process.platform !== "win32") {
		it("--help works without bun on PATH", () => {
			const res = spawnSync(process.execPath, [CLI, "--help"], {
				encoding: "utf8",
				timeout: 15_000,
				env: { ...process.env, PATH: TMP, HOME: TMP, OMP_DECK_DATA_DIR: path.join(TMP, "data") },
			});
			expect(res.status).toBe(0);
			expect(res.stdout).toContain("Usage");
		});
	}
});
