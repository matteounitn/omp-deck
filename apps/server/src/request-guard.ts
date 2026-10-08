/**
 * Request guards for the loopback-only HTTP/WS surface.
 *
 * The deck is unauthenticated by design and binds to loopback, but "loopback"
 * is not a boundary against the browser running on the same machine: any web
 * page the operator visits can POST to `127.0.0.1:<port>` as a CORS *simple
 * request* (safelisted content type such as `text/plain`, so no preflight is
 * sent) and can open a WebSocket, which CORS does not cover at all. In 0.6.1
 * that was enough for command execution (`POST /api/routines` then
 * `POST /api/routines/:id/run`, whose bash action runs `bash -lc`).
 *
 * Two cheap guards remove the class:
 *
 *  1. `Origin` MUST match `Host` when present. Browsers send `Origin` for every
 *     cross-origin request (and for same-origin non-GET fetches), while
 *     non-browser clients (curl, scripts, webhook senders) send none — so this
 *     rejects the browser as a confused deputy without breaking automation.
 *     Setups where a proxy rewrites `Host` (the Vite dev server sets
 *     `changeOrigin: true`) are covered by `allowedOrigins`.
 *  2. A *present* `Content-Type` on a mutating API request must be JSON. The
 *     safelisted types (`text/plain`, `application/x-www-form-urlencoded`,
 *     `multipart/form-data`) are what let a cross-site page skip the preflight,
 *     so rejecting them closes the simple-request path for every handler that
 *     reads a body. An absent header is allowed: the UI issues many bodyless
 *     POSTs, and for those guard 1 is the control (a page can also send a
 *     body with no Content-Type), so this rule is defense in depth. The two
 *     documented non-JSON endpoints (image upload, routine webhooks) are exempt.
 *
 * Known residual: DNS rebinding (attacker hostname resolving to 127.0.0.1 with
 * the port in the URL) still matches Origin == Host. Closing that needs a Host
 * allowlist, which the loopback default plus proxy deployments make a separate
 * design decision.
 */

export interface RequestGuardOptions {
	/** Origins (scheme://host[:port]) accepted in addition to an Origin/Host match. */
	allowedOrigins?: readonly string[];
	/** Router-relative path without the `/api` prefix, used for non-JSON exemptions. */
	apiPath?: string;
}

const MUTATING_METHODS: Record<string, true> = { POST: true, PUT: true, PATCH: true, DELETE: true };

/** Endpoints that legitimately accept a non-JSON body (see routes-uploads.ts, routes-hooks.ts). */
const NON_JSON_API_PATHS = [/^\/uploads\//, /^\/hooks\//];

/** Host part (`host:port`, lowercased) of an origin or absolute URL, or null when unparsable. */
export function originHost(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		return new URL(value).host.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Returns the rejection Response when the request must not be served, or null to
 * continue. Pure function of the request + options, so it is unit-testable
 * without booting a server.
 */
export function guardRequest(req: Request, opts: RequestGuardOptions = {}): Response | null {
	const origin = req.headers.get("origin");
	if (origin) {
		const requested = originHost(origin);
		// Bun.serve always provides Host; fall back to the request URL's host so
		// the guard also holds when a runtime/dispatcher omits the header.
		const host = (req.headers.get("host") ?? originHost(req.url) ?? "").toLowerCase();
		const allowlisted = (opts.allowedOrigins ?? []).some((candidate) => originHost(candidate) === requested);
		if (!allowlisted && (requested === null || host === "" || requested !== host)) {
			return new Response(JSON.stringify({ error: "cross-origin request rejected" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			});
		}
	}

	if (MUTATING_METHODS[req.method] === true) {
		const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
		const exempt = NON_JSON_API_PATHS.some((pattern) => pattern.test(opts.apiPath ?? ""));
		// A MISSING Content-Type is allowed: the UI issues many bodyless POSTs
		// ("/sessions/:id/abort", "/server/restart", bridge start/stop, kb init,
		// marketplace refresh, routine template install, …) and rejecting them
		// would break the app. A cross-site page can still send a body with no
		// Content-Type (an empty-type Blob), so this rule is defense in depth —
		// the Origin/Host check above is the control for those requests.
		if (!exempt && contentType !== "" && !contentType.startsWith("application/json")) {
			return new Response(JSON.stringify({ error: "content-type must be application/json" }), {
				status: 415,
				headers: { "content-type": "application/json" },
			});
		}
	}

	return null;
}
