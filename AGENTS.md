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
- The production hostname is `https://hp.operagrid.net`; its Cloudflare DNS
  record and the Daikin developer application were updated by the user.
- The exact registered Daikin OIDC callback is
  `https://hp.operagrid.net/oauth/callback`.
- The production app is live on Vercel. Cloudflare points `hp.operagrid.net`
  to Vercel, the custom domain is verified, Basic authentication protects all
  UI/API/static routes, and the OAuth callback is the only public route.
- Vercel is connected to `github.com/marianfurdui/pdc-manager`: every push to
  `main` automatically creates and promotes a production deployment for
  `hp.operagrid.net`; other branches and pull requests receive previews.
- An Upstash Redis store is attached and application data is encrypted with
  AES-256-GCM before storage. With explicit user approval, the existing local
  ONECTA client configuration and refresh session were migrated and verified;
  private LAN settings and transient OAuth/cache data were excluded.
- ONECTA OAuth is connected, encrypted tokens are stored, and authenticated
  API calls succeed.
- The PWA has a capability-driven heat-pump UI: per-zone dials with debounced,
  optimistic writes on Home, switches/segments/steppers under Controls,
  temperature-coloured weekly timelines with a copy-to-days editor, an energy
  chart when consumption data is reported, dark mode, and a dedicated
  connected-but-waiting state while no gateway is returned. System also has a
  read-only Wi-Fi gateway reachability check using the existing safe LAN probe.
- An energy review is prepared for when the device appears: home profile,
  read-only efficiency rules, an encrypted history journal (separate store
  key), Open-Meteo degree-days from the rounded location, and
  `scripts/efficiency-audit.mjs`. Procedure and reasoning are in
  `docs/EFFICIENCY_PLAYBOOK.md`. Owner context: underfloor heating, flat
  tariff, no solar, so the goal is fewer kWh, not time-shifting.
- `GET /v1/gateway-devices` currently returns an empty array with no API error.
- ONECTA onboarding reports `ALREADY_REGISTERED_TO_OTHER`. Daikin support has
  been asked to release the stale gateway ownership. This is the immediate
  blocker to reading or controlling the real heat pump.
- The installed A71 responds to UDP discovery on port 30050 and identifies its
  model, but no local heat-pump status/control API has been found. Known A61/A62
  `/mca`, legacy HTTP, and tested UDP control/status requests are unavailable.
- A redacted, read-only A71 setup-mode inspector is available in the local
  System page and as `npm run inspect:a71 -- 192.168.10.1`. It sends only
  bounded GETs and empty WebSocket handshakes; it has not yet been run while
  the Mac is connected to `daikin-ap`.
- The Mac dashboard remains available locally and retains LAN probing. The
  hosted runtime deliberately disables LAN reachability and uses ONECTA only.

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
  must route only to the Vercel application, never the Mac or another LAN
  device.
- Keep adapter research read-only unless the user explicitly authorizes a
  reviewed state-changing experiment. Do not brute-force credentials, flash
  firmware, bypass TLS controls, or send speculative heat-pump commands.
- Preserve RFC1918/link-local/`.local` validation on local probe targets.
- Preserve capability-driven control: never expose a write unless ONECTA or
  the compatible local adapter advertises it as settable and its values/ranges
  have been validated.
- The repository intentionally has zero runtime npm dependencies. Node 22+
  is required; Node 24 is recommended.
- Keep the production `APP_SECRET` stable. Rotating it without re-encrypting
  the Redis document makes the hosted ONECTA settings unreadable.
- Use `apply_patch` for edits. Run `npm test` and `npm run check` after code
  changes.

## Known follow-up work

1. Verify device discovery after Daikin releases the gateway and it is
   onboarded.
2. Map the real device's management points, actions, schedules, enum values,
   ranges and units from a redacted payload. Preserve the generic fallback;
   add model-specific labels only from that redacted real payload.
3. Sign in to the hosted UI with the application password, then verify the
   migrated ONECTA connection and device refresh.
4. Make **Disconnect cloud** revoke tokens at Daikin. `disconnect()` currently
   only deletes the locally stored tokens; treat that as a documented gap until
   it is fixed and tested.
5. Run the read-only A71 setup-mode inspection while the Mac is connected to
   `daikin-ap`; review the exact result before authorizing any state change.
6. Continue optional A71 protocol research only as scoped in
   `RESEARCH_STATUS.md`.
7. Run the energy review in `docs/EFFICIENCY_PLAYBOOK.md` once the device
   appears. Suggestions stay proposals: change one setting at a time, only
   with the owner's approval.

