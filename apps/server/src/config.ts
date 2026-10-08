import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Config {
	host: string;
	port: number;
	defaultCwd: string;
	extraWorkspaces: string[];
	agentDir?: string;
	webDist?: string;
	devMode: boolean;
	/** Ms a session may sit without WS subscribers before the reaper disposes it. 0 disables. */
	idleTimeoutMs: number;
	/** Absolute path to the sqlite database file. */
	dbPath: string;
	/** Absolute path to the uploads root (images pasted into task bodies). */
	uploadsRoot: string;
	/**
	 * Prompt to fire automatically on every NEW session once a WS subscriber
	 * attaches. Empty string or null disables. Default: "/start" (expands to the
	 * ~/.omp/agent/commands/start.md slash command if present).
	 */
	autoStartCommand: string | null;
	/**
	 * Browser origins accepted in addition to a matching Origin/Host pair (see
	 * request-guard.ts). Needed when something in front rewrites Host: the Vite
	 * dev server (changeOrigin: true) makes the browser's `:<webPort>` origin no
	 * longer match the Host we receive, so the loopback dev origins are included
	 * by default. Extend with OMP_DECK_ALLOWED_ORIGINS (comma-separated).
	 */
	allowedOrigins: string[];
}

export function parseInt10(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}

export function parseAutoStart(value: string | undefined): string | null {
	// Default is OFF on a fresh install: a new session lands on an empty
	// composer waiting for the user's first prompt. Opt-in by setting the env
	// var (typically to `/start` after creating `~/.omp/agent/commands/start.md`).
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "0" || trimmed.toLowerCase() === "false") return null;
	return trimmed;
}

export function splitList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function resolveWebDist(): string | undefined {
	const explicit = process.env.OMP_DECK_WEB_DIST?.trim();
	const candidates = [
		explicit,
		// Common deployment layouts:
		path.resolve(process.cwd(), "public"),
		path.resolve(process.cwd(), "../web/dist"),
		path.resolve(process.cwd(), "../../apps/web/dist"),
	].filter((c): c is string => Boolean(c));
	for (const c of candidates) {
		try {
			if (fs.statSync(c).isDirectory()) return c;
		} catch {
			// not found — try the next candidate
		}
	}
	return undefined;
}

export function loadConfig(): Config {
	const home = os.homedir();
	const defaultCwd = process.env.OMP_DECK_DEFAULT_CWD?.trim() || home;
	const extra = splitList(process.env.OMP_DECK_WORKSPACES);
	const agentDir = process.env.OMP_AGENT_DIR?.trim() || undefined;
	const webDist = resolveWebDist();
	const host = process.env.OMP_DECK_HOST?.trim() || "127.0.0.1";
	const webPort = process.env.OMP_DECK_WEB_PORT?.trim() || "5173";
	const devMode = process.env.NODE_ENV !== "production";
	const packaged = process.env.OMP_DECK_PACKAGED === "1";

	return {
		host,
		port: parseInt10(process.env.OMP_DECK_PORT, 8787),
		defaultCwd: path.resolve(defaultCwd),
		extraWorkspaces: extra.map((p) => path.resolve(p)),
		agentDir,
		webDist,
		devMode,
		// 5 minutes default. Set to 0 to disable reaping (kernels live until SIGINT).
		idleTimeoutMs: parseInt10(process.env.OMP_DECK_IDLE_TIMEOUT_MS, 5 * 60_000),
		dbPath: path.resolve(
			process.env.OMP_DECK_DB_PATH?.trim() ||
				process.env.OMP_DECK_DB?.trim() ||
				path.join(process.cwd(), "data", "deck.db"),
		),
		uploadsRoot: path.resolve(
			process.env.OMP_DECK_UPLOADS_ROOT?.trim() ||
				path.join(
					path.dirname(
						path.resolve(
							process.env.OMP_DECK_DB_PATH?.trim() ||
								process.env.OMP_DECK_DB?.trim() ||
								path.join(process.cwd(), "data", "deck.db"),
						),
					),
					"uploads",
				),
		),
		// Set OMP_DECK_AUTO_START="" or "0" to disable, or to any other prompt
		// string to override the default "/start" slash-command invocation.
		autoStartCommand: parseAutoStart(process.env.OMP_DECK_AUTO_START),
		allowedOrigins: [
			...splitList(process.env.OMP_DECK_ALLOWED_ORIGINS),
			// `bun run dev` only: the browser loads the UI from the Vite dev server
			// and Vite proxies /api to us with changeOrigin, so Origin (:5173) and
			// Host (:port) differ. A packaged install (OMP_DECK_PACKAGED, set by
			// bin/omp-deck.mjs) and production mode never get them — allowlist such
			// origins explicitly via OMP_DECK_ALLOWED_ORIGINS instead. Residual: a
			// source `bun run start` with NODE_ENV unset still counts as dev.
			...(devMode && !packaged ? [`http://${host}:${webPort}`, `http://localhost:${webPort}`] : []),
		],
	};
}
