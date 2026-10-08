import { describe, expect, it } from "bun:test";

import { guardRequest, originHost } from "./request-guard.ts";

const HOST = "127.0.0.1:8787";
const SAME_ORIGIN = `http://${HOST}`;

function apiRequest(path: string, init: RequestInit = {}): Request {
	return new Request(`http://${HOST}/api${path}`, init);
}

function post(path: string, headers: Record<string, string>, body = "{}"): Request {
	return apiRequest(path, { method: "POST", headers, body });
}

describe("originHost", () => {
	it("normalizes host:port and rejects unparsable values", () => {
		expect(originHost("http://127.0.0.1:8787")).toBe("127.0.0.1:8787");
		expect(originHost("HTTP://LOCALHOST:5173")).toBe("localhost:5173");
		expect(originHost("null")).toBeNull();
		expect(originHost("")).toBeNull();
		expect(originHost(undefined)).toBeNull();
	});
});

describe("guardRequest: Origin/Host", () => {
	it("allows requests without Origin (curl, scripts, webhook senders)", () => {
		expect(guardRequest(post("/routines", { "content-type": "application/json" }))).toBeNull();
	});

	it("allows same-origin browser requests", () => {
		expect(guardRequest(post("/routines", { origin: SAME_ORIGIN, "content-type": "application/json" }))).toBeNull();
	});

	it("rejects cross-origin writes with 403", async () => {
		const res = guardRequest(post("/routines", { origin: "https://evil.example", "content-type": "application/json" }));
		expect(res?.status).toBe(403);
		expect(await res?.json()).toEqual({ error: "cross-origin request rejected" });
	});

	it("rejects cross-origin reads too", () => {
		expect(guardRequest(apiRequest("/sessions", { headers: { origin: "https://evil.example" } }))?.status).toBe(403);
	});

	it("rejects a malformed Origin header", () => {
		expect(guardRequest(post("/routines", { origin: "null", "content-type": "application/json" }))?.status).toBe(403);
	});

	it("treats a port mismatch as cross-origin", () => {
		expect(guardRequest(post("/routines", { origin: "http://127.0.0.1:9999", "content-type": "application/json" }))?.status).toBe(403);
	});

	it("allows allowlisted origins (Vite dev proxy rewrites Host)", () => {
		const res = guardRequest(post("/routines", { origin: "http://127.0.0.1:5173", "content-type": "application/json" }), {
			allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
		});
		expect(res).toBeNull();
	});
});

describe("guardRequest: JSON content type", () => {
	it("rejects text/plain even same-origin (the CSRF simple-request vector)", async () => {
		const res = guardRequest(post("/routines", { origin: SAME_ORIGIN, "content-type": "text/plain" }));
		expect(res?.status).toBe(415);
		expect(await res?.json()).toEqual({ error: "content-type must be application/json" });
	});

	it("rejects form-encoded bodies", () => {
		expect(guardRequest(post("/routines", { origin: SAME_ORIGIN, "content-type": "application/x-www-form-urlencoded" }))?.status).toBe(415);
	});

	it("allows bodyless mutating requests (UI calls without a content type)", () => {
		// e.g. api.abortSession(), settings.restartServer(), bridges.start(): { method: "POST" } and no body.
		const abort = apiRequest("/sessions/s_1/abort", { method: "POST", headers: { origin: SAME_ORIGIN } });
		expect(guardRequest(abort, { apiPath: "/sessions/s_1/abort" })).toBeNull();

		const restart = apiRequest("/server/restart", { method: "POST", headers: { origin: SAME_ORIGIN } });
		expect(guardRequest(restart, { apiPath: "/server/restart" })).toBeNull();
	});

	it("still blocks bodyless mutating requests from another origin", () => {
		const run = apiRequest("/routines/r_1/run", { method: "POST", headers: { origin: "https://evil.example" } });
		expect(guardRequest(run, { apiPath: "/routines/r_1/run" })?.status).toBe(403);
	});

	it("accepts application/json with parameters", () => {
		expect(guardRequest(post("/routines", { origin: SAME_ORIGIN, "content-type": "application/json; charset=utf-8" }))).toBeNull();
	});

	it("covers PUT, PATCH and DELETE", () => {
		for (const method of ["PUT", "PATCH", "DELETE"]) {
			const req = apiRequest("/routines/r_1", {
				method,
				headers: { origin: SAME_ORIGIN, "content-type": "text/plain" },
				body: "x",
			});
			expect(guardRequest(req, { apiPath: "/routines/r_1" })?.status).toBe(415);
		}
	});

	it("exempts image uploads and routine webhooks", () => {
		const upload = post("/uploads/image", { origin: SAME_ORIGIN, "content-type": "multipart/form-data; boundary=x" }, "x");
		expect(guardRequest(upload, { apiPath: "/uploads/image" })).toBeNull();

		const hook = post("/hooks/inbox-triager-manual", { origin: SAME_ORIGIN, "content-type": "text/plain" }, "payload");
		expect(guardRequest(hook, { apiPath: "/hooks/inbox-triager-manual" })).toBeNull();
	});

	it("does not exempt lookalike paths", () => {
		const req = post("/uploads-config", { origin: SAME_ORIGIN, "content-type": "text/plain" }, "x");
		expect(guardRequest(req, { apiPath: "/uploads-config" })?.status).toBe(415);
	});
});
