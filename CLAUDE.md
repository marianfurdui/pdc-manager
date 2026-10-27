# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted dashboard (Node server + vanilla-JS PWA) for a Daikin Altherma 3 H HT heat pump: indoor unit `ETVX16S23D9W`, outdoor unit `EPRA14DW1`, Wi-Fi adapter `BRP069A71`. It has **zero npm dependencies**: only Node built-ins (`node:http`, `node:crypto`, global `fetch`/`WebSocket`, `node:test`). Do not add packages without a strong reason. Node ≥ 22 is required (24 recommended) because the local connector uses the global `WebSocket`.

The BRP069A71 appears to be cloud-only. It answers UDP discovery on port 30050 with its model, but no local status or control API has been found. Real control therefore goes through the official **ONECTA cloud API**. The local `/mca` connector targets BRP069A61/A62 adapters and does not work against this unit.

Earlier sessions were done with Codex, and the project docs are shared between agents. Before changing anything, read:
- `RESEARCH_STATUS.md`: the authoritative record of evidence, live deployment state, blockers and next steps. Update it when the investigation or deployment changes.
- `AGENTS.md`: the cross-agent handoff (current state, safety rules, follow-up list). Keep it consistent with this file.
- `README.md`: user-facing setup, hardware compatibility and the account-recovery procedure.

## Current deployment state (2026-10-27)

- The dashboard runs on loopback at `http://127.0.0.1:8787`.
- The production hostname is `https://hp.operagrid.net`. The user changed its Cloudflare DNS record for Vercel and registered exactly `https://hp.operagrid.net/oauth/callback` in the Daikin developer app.
- `api/index.js` and `vercel.json` adapt the same request handler to Vercel. The deployment is live: the Cloudflare/Vercel custom domain, TLS, Basic authentication, public OAuth callback, and Upstash-backed encrypted store have been verified. With explicit user approval, the existing ONECTA client configuration and refresh session were migrated and read back successfully; private LAN settings and transient OAuth/cache data were excluded.
- ONECTA OAuth and consent are complete: encrypted tokens are stored, `connected` is true, and authenticated API calls succeed.
- **`/v1/gateway-devices` returns `[]` with no error.** This is a device-ownership problem: onboarding reports `ALREADY_REGISTERED_TO_OTHER`, and Daikin support has been asked to release the gateway. Do not misdiagnose it as an OAuth, HTTPS or transport failure. Once the gateway is onboarded to the authorized account, call `/api/devices?refresh=true` and inspect a redacted payload before adding any model-specific assumptions.
- The Mac runtime remains local and supports LAN probing. The Vercel runtime is ONECTA-only and deliberately cannot probe or control LAN adapters.

## Commands

```sh
npm start                      # node src/local-server.js on http://127.0.0.1:8787
npm run dev                    # DEMO_MODE=true with --watch (fake device, writes are no-ops)
npm test                       # node --test (runs test/*.test.js)
node --test test/onecta.test.js                         # single file
node --test --test-name-pattern="round-trips" test/     # single test by name
npm run check                  # syntax check all server and browser entry points
node scripts/research-a71.mjs <private-ip>              # read-only BRP069A71 HTTP/UDP probe (redact IP/MAC in output)
docker compose up -d --build   # container; data is in the altherma-data volume
```

Run `npm test` and `npm run check` after code changes.

Environment variables: `HOST` (default `127.0.0.1`), `PORT` (8787), `DATA_DIR` (default `./data`), `APP_PASSWORD` (HTTP Basic auth; the server **refuses to start** on a non-loopback `HOST` without it), `APP_SECRET` (optional stable key material for the store), `PUBLIC_URL` (HTTPS origin, required for OAuth behind a proxy or tunnel), `DEMO_MODE=true`.

## Architecture

- **`src/app-handler.js`**: shared authenticated request handler for OAuth, API routes and static files. Each request body carries `source: "local" | "cloud"`, and the server dispatches to the matching connector. `/api/devices` merges available snapshots and returns per-connector errors rather than failing outright.
- **`src/local-server.js`**: thin long-running Mac/Node wrapper using `SecureStore`; local LAN features are enabled. Its name intentionally avoids Vercel's zero-config `src/server.js` detection.
- **`api/index.js`**: Vercel function wrapper using `RedisSecureStore`; local LAN features are disabled and route rewrites restore the public request URL.
- **Connectors** share a loose shape (`snapshot`, `write`, `writeSchedule`) but return different device shapes:
  - `src/connectors/local-altherma.js`: oneM2M-style JSON over `ws://<host>/mca`. Reads use the `READERS` item map. Writes are only allowed through the `WRITERS` whitelist, which validates ranges. Schedules use a custom `$NULL|1|HHMM,value;...` string encoding (`marshallSchedule`/`unmarshallSchedule`, max 6 changes per day; tank values are semantic modes). `probe()` falls back to `classifyCloudGatewayHttp` to recognize an A71-style gateway and stores `localControl: false`, which makes the server skip local snapshots.
  - `src/connectors/onecta.js`: OAuth2 authorization code flow with PKCE and state. Pending states live in memory with a 10-minute expiry, so restarting the server breaks a login that is in progress. It also handles token refresh and a single retry on 401. Observed quota headers are 20 requests/minute and 200 requests/day, so `/v1/gateway-devices` responses are cached for **8 minutes** and writes clear the cache. `normalizeCloudDevices` flattens every characteristic into `leaves` with `settable/min/max/step`. Writes are rejected unless the unit advertises the characteristic or path as `settable`, so the UI and server are capability-driven rather than hardcoded.
- **`src/lib/store.js`**: local `SecureStore` keeps settings and OAuth tokens AES-256-GCM encrypted in `data/settings.enc.json`.
- **`src/lib/redis-store.js`**: hosted `RedisSecureStore` encrypts the entire settings document with AES-256-GCM before writing it to an Upstash-compatible Redis REST endpoint. It requires a stable `APP_SECRET`.
- **`src/lib/errors.js`**: throw `AppError(message, status, code, details)` for anything the user should see. Any other error becomes a generic 500 via `publicError`.
- **`src/lib/http.js`**: `readJson` enforces the content type and a size cap, `safeSegment` encodes untrusted URL path segments, and `fetchWithTimeout` handles upstream calls.
- **`public/app.js`**: a no-build SPA that renders HTML strings. Interpolated values must go through `escapeHtml`. The CSP forbids inline scripts and styles.

## Constraints to preserve

- **Capability-driven control.** Never expose a write unless ONECTA or a compatible local adapter advertises it as settable and its values and ranges have been validated.
- Local probe targets must pass `validateLocalHost`: RFC1918 or link-local IPv4, or `*.local`. This prevents SSRF.
- Only `/oauth/callback` bypasses Basic auth, and it is protected by the single-use PKCE `state`. `/api/cloud/connect` and everything else stay behind auth.
- Daikin rejects `http://` and `https://localhost` redirect URIs, so OAuth needs the HTTPS tunnel. A Daikin developer app does not need a registered API product, even when the portal shows **No Products**.
- Serverless hosting must use the Redis-backed store and persisted OAuth PKCE state. Never rely on Vercel's ephemeral filesystem for credentials or tokens.
- Never port-forward or tunnel directly to the BRP069A71. The public hostname must route only to the loopback-bound app.
- Adapter research stays **read-only** unless the user explicitly authorizes a reviewed experiment that changes state. Do not brute-force credentials, flash firmware, bypass TLS or certificate pinning, or send speculative commands to the heat pump.
- Never commit, print or quote `data/`, `.cloudflared/`, tunnel credentials or the origin certificate, the client secret, tokens, application passwords, private IPs, MACs, serial or QR values, or account IDs.

## Known follow-up work

1. Verify device discovery after Daikin releases the gateway and it is onboarded.
2. Map the real device's management points, actions, schedules, enum values, ranges and units from a redacted payload.
3. Sign in to the hosted UI with the application password, then verify the migrated ONECTA connection and device refresh.
4. Make **Disconnect cloud** revoke tokens at Daikin. `disconnect()` currently only deletes the locally stored tokens; treat that as a documented gap until it is fixed and tested.
5. Continue optional A71 protocol research only as scoped in `RESEARCH_STATUS.md`.

<!-- imported-from: codex:project:instructions -->
# Agent Handoff

Read these files before changing the project:

1. `RESEARCH_STATUS.md` — authoritative evidence, live deployment state,
   blockers, known gaps, and next steps.
2. `README.md` — user-facing setup, hardware compatibility, and operation.
3. `CLAUDE.md` — implementation architecture and code constraints.

## Current state (2026-10-27)

- Hardware: Daikin Altherma 3 H HT with indoor `ETVX16S23D9W`, outdoor
  `EPRA14DW1`, and Wi-Fi adapter `BRP069A71`.
- The local dashboard runs at `http://127.0.0.1:8787`.
- The production dashboard is live at `https://hp.operagrid.net`; its
  Cloudflare/Vercel custom domain, TLS, Basic authentication, and public OAuth
  callback route are verified.
- The Daikin OIDC callback is registered as
  `https://hp.operagrid.net/oauth/callback`.
- ONECTA OAuth is connected, encrypted tokens are stored, and authenticated
  API calls succeed.
- `GET /v1/gateway-devices` currently returns an empty array with no API error.
- ONECTA onboarding reports `ALREADY_REGISTERED_TO_OTHER`. Daikin support has
  been asked to release the stale gateway ownership. This is the immediate
  blocker to reading or controlling the real heat pump.
- The installed A71 responds to UDP discovery on port 30050 and identifies its
  model, but no local heat-pump status/control API has been found. Known A61/A62
  `/mca`, legacy HTTP, and tested UDP control/status requests are unavailable.
- The Mac runtime supports LAN access; Vercel is ONECTA-only and stores
  encrypted settings in Redis.

Do not misdiagnose the empty device list as an OAuth failure. OAuth, HTTPS,
callback handling, token exchange, and the ONECTA API transport have all been
verified. After Daikin releases and the user onboards the gateway into the
authorized ONECTA account, refresh `/api/devices?refresh=true` and inspect a
redacted payload before adding model-specific assumptions.

## Safety and repository rules

- Do not commit, print, quote, or copy private IPs, MAC addresses, serial/QR
  values, user/account IDs, passwords, client secrets, OAuth tokens,
  `data/`, `.cloudflared/`, Cloudflare certificates, or tunnel credentials.
- Never port-forward or tunnel directly to the BRP069A71. The public hostname
  must route only to the loopback-bound application server.
- Keep adapter research read-only unless the user explicitly authorizes a
  reviewed state-changing experiment. Do not brute-force credentials, flash
  firmware, bypass TLS controls, or send speculative heat-pump commands.
- Preserve RFC1918/link-local/`.local` validation on local probe targets.
- Preserve capability-driven control: never expose a write unless ONECTA or
  the compatible local adapter advertises it as settable and its values/ranges
  have been validated.
- The repository intentionally has zero runtime npm dependencies. Node 22+
  is required; Node 24 is recommended.
- Use `apply_patch` for edits. Run `npm test` and `npm run check` after code
  changes.

## Known follow-up work

1. Verify device discovery after account release/onboarding.
2. Inspect and safely map the real device's management points, actions,
   schedules, enum values, ranges, and units.
3. Sign in to the hosted UI with the application password, then verify the
   migrated ONECTA connection and device refresh.
4. Implement and test Daikin access/refresh-token revocation for
   **Disconnect cloud**. It currently removes only locally stored tokens.
5. Continue optional A71 protocol research only as documented in
   `RESEARCH_STATUS.md`.
