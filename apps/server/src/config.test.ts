import { afterEach, describe, expect, it } from "bun:test";

import { loadConfig } from "./config.ts";

/** Keys this suite mutates, restored after each case so the ambient env wins again. */
const TOUCHED = ["NODE_ENV", "OMP_DECK_PACKAGED", "OMP_DECK_ALLOWED_ORIGINS", "OMP_DECK_WEB_PORT"] as const;
const saved = new Map<string, string | undefined>(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** The shape a packaged `omp-deck` run has: deck-private flag, no NODE_ENV. */
function packagedEnv(): void {
	delete process.env.OMP_DECK_ALLOWED_ORIGINS;
	delete process.env.NODE_ENV;
	process.env.OMP_DECK_PACKAGED = "1";
	process.env.OMP_DECK_WEB_PORT = "5173";
}

describe("loadConfig: allowedOrigins", () => {
	it("allows the Vite dev origins in a source dev run", () => {
		delete process.env.OMP_DECK_ALLOWED_ORIGINS;
		delete process.env.OMP_DECK_PACKAGED;
		delete process.env.NODE_ENV;
		process.env.OMP_DECK_WEB_PORT = "5173";
		expect(loadConfig().allowedOrigins).toContain("http://127.0.0.1:5173");
	});

	it("drops them in production mode", () => {
		delete process.env.OMP_DECK_ALLOWED_ORIGINS;
		delete process.env.OMP_DECK_PACKAGED;
		process.env.OMP_DECK_WEB_PORT = "5173";
		process.env.NODE_ENV = "production";
		expect(loadConfig().allowedOrigins).toEqual([]);
	});

	it("drops them for a packaged install, which does not set NODE_ENV", () => {
		packagedEnv();
		expect(loadConfig().allowedOrigins).toEqual([]);
	});

	it("keeps explicitly allowlisted origins in production", () => {
		delete process.env.OMP_DECK_PACKAGED;
		process.env.NODE_ENV = "production";
		process.env.OMP_DECK_ALLOWED_ORIGINS = "https://deck.example.ts.net , http://127.0.0.1:5173";
		expect(loadConfig().allowedOrigins).toEqual(["https://deck.example.ts.net", "http://127.0.0.1:5173"]);
	});

	it("honours OMP_DECK_WEB_PORT for the dev origin", () => {
		delete process.env.OMP_DECK_ALLOWED_ORIGINS;
		delete process.env.OMP_DECK_PACKAGED;
		delete process.env.NODE_ENV;
		process.env.OMP_DECK_WEB_PORT = "6001";
		expect(loadConfig().allowedOrigins).toContain("http://127.0.0.1:6001");
	});
});
