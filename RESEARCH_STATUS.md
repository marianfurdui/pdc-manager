# BRP069A71 Investigation and Implementation Status

Last updated: 2026-10-27

## Objective

Provide local and remote access to the Daikin Altherma 3 H HT without losing
the option to use ONECTA after Daikin releases the gateway from the previous
account.

The intended end state is:

- local status and control when the installed adapter exposes a usable LAN API;
- remote access through the official ONECTA API;
- discovery of schedules, capabilities, and writable actions instead of
  assuming every heat-pump configuration supports the same features;
- no port-forwarding or direct internet exposure of the heat pump.

## Current operational summary

As of 2026-10-27:

- the local dashboard is running on loopback at `http://127.0.0.1:8787`;
- the production dashboard is live at `https://hp.operagrid.net`; Cloudflare
  points the verified custom domain to Vercel;
- the public dashboard requires HTTP Basic authentication;
- the Daikin developer application has the exact registered redirect URI
  `https://hp.operagrid.net/oauth/callback`;
- ONECTA OAuth authorization and consent completed successfully;
- encrypted access and refresh tokens are stored locally;
- authenticated ONECTA API requests succeed;
- `GET /v1/gateway-devices` currently succeeds with an empty array, so no
  heat-pump features or actions can yet be shown;
- the remaining control blocker is the BRP069A71 cloud ownership/onboarding
  state, not the dashboard, HTTPS tunnel, OAuth client, or API transport.

The Vercel function, production environment, custom-domain routing, TLS, Basic
authentication, public OAuth callback, and encrypted Redis integration are
deployed and verified. The existing local ONECTA credentials/session have not
yet been exported to the hosted store; this requires explicit user approval,
or a fresh ONECTA connection can be made from the hosted UI. The Mac runtime
remains available for LAN-only checks.

## Identified installation

| Component | Model / status |
| --- | --- |
| Heat pump | Daikin Altherma 3 H HT reversible |
| Indoor unit | `ETVX16S23D9W`, 230 L hydrotank |
| Outdoor unit | `EPRA14DW1`, 14 kW, three phase |
| Wireless adapter | `BRP069A71` WLAN module for heating |
| Indoor controller | D-series user interface |
| Adapter LEDs observed | RUN illuminated; AP not active during the photo |

Serial numbers, MAC addresses, QR codes, private IP addresses, account IDs,
OAuth credentials, and tokens are deliberately omitted from this document.

## Account and ONECTA status

- The application completed ONECTA OAuth successfully through
  `https://hp.operagrid.net/oauth/callback`. Existing access and refresh tokens are
  encrypted in the local settings store.
- Authenticated calls to the ONECTA API succeed, but the authorized account
  currently returns zero gateway devices.
- ONECTA detects the adapter but reports
  `ALREADY_REGISTERED_TO_OTHER`: the gateway is still assigned to another
  Daikin account.
- An ownership/account-release request has been sent to Daikin support.
- The old application is no longer usable for removing the device.
- The generic ONECTA help screen says to select **Wireless gateway → Remove
  from cloud** on the indoor controller. That sequence does not match this
  installation. On the observed D-series controller, enabling Advanced User
  does not add that entry to the main menu.
- The D-series gateway menu documented for this controller generation consists
  of mode, WPS, reset, and device information. A whole-unit factory reset is
  not an appropriate substitute for Daikin releasing the cloud registration.
- The application keeps the official ONECTA connector ready. Once Daikin
  releases the adapter and it is added to the authorized account, refreshing
  the application should discover it without repeating OAuth unless Daikin has
  revoked or expired the existing authorization.

### Verified ONECTA integration details

- Developer application name: `pdc_control`.
- Authentication strategy: ONECTA OIDC authorization-code flow.
- Scopes: `openid`, `onecta:basic.integration`, and `offline_access`.
- PKCE `S256` and a random, single-use OAuth `state` value are used.
- The callback is public so the identity provider can return the authorization
  code; the callback accepts a code only when its state matches a pending,
  unexpired authorization request.
- The token exchange sends `client_id`, `client_secret`, authorization code,
  redirect URI, and PKCE verifier as form fields, matching the current Daikin
  documentation.
- The Daikin portal displays **No Products** for the application. Current
  Daikin documentation explicitly says API-product registration is not
  required for developer applications.
- The first successful API calls reported limits of 20 requests per minute and
  200 requests per day. The connector caches device reads for eight minutes
  and records the returned limit headers.
- Successful OAuth proves that the client ID, client secret, redirect URI,
  consent flow, token exchange, encrypted token storage, tunnel, and callback
  are working. An empty device array is a valid API response and is distinct
  from authentication or transport failure.

### Production hosting migration

- Production hostname: `hp.operagrid.net`.
- Cloudflare DNS and the Daikin redirect URI were updated by the user.
- Vercel serves the PWA and Node function. All public routes, including static
  assets and APIs, pass through application Basic authentication; only the
  single-use-state OAuth callback is public.
- Settings, credentials, PKCE state, tokens, and the short-lived ONECTA cache
  are encrypted before they are stored in Redis.
- The Vercel runtime cannot reach the private LAN. Gateway probing remains a
  Mac-only function, and no public route targets the Wi-Fi adapter.

## Verified LAN findings for BRP069A71

The tests below were performed against the adapter on the home LAN. They were
read-only: no configuration or heat-pump values were changed.

### Network services

- The adapter was matched on the LAN using its photographed MAC address.
- TCP port 80 responds.
- Common alternative service ports tested did not respond, including SSH,
  Telnet, HTTPS, MQTT/MQTTS, RTSP, common development web ports, and typical
  alternate HTTP ports.
- This does not prove that every possible port is closed; it records the
  targeted survey completed so far.

### HTTP behavior

The HTTP server returns a small plain-text `404 ... not_found` response for:

- `/`;
- the legacy Daikin endpoint `/common/basic_info`;
- legacy `/aircon/get_model_info`, `/aircon/get_sensor_info`, and
  `/aircon/get_control_info` endpoints;
- the Altherma `/mca` endpoint used by BRP069A61/A62 adapters;
- `/dsiot/multireq`;
- a curated group of read-only paths under `/api`, `/gateway`, `/system`,
  `/device`, `/wifi`, `/network`, `/status`, and `/version`.

No HTTP endpoint providing temperatures, operating state, schedules, or
control was found.

### UDP behavior

The adapter responds on UDP port 30050 to:

```text
DAIKIN_UDP/common/basic_info
```

The reply identifies the adapter model as `BRP069A71` and returns its MAC
address. This is a useful local discovery mechanism, but it does not provide
heat-pump state or control.

No reply was observed for the tested UDP requests for device/unit information,
Wi-Fi/network settings, remote method, time, version, air-conditioner model,
sensors, controls, `/dsiot/multireq`, or `/mca`.

### Current conclusion

The installed BRP069A71 is reachable locally and supports model discovery, but
the investigation has not found a local heat-pump status/control API. Its
behavior differs from the BRP069A61/A62 adapters that expose the known `/mca`
WebSocket protocol.

This is a current evidence-based result, not proof that no undocumented local
control path exists. The remaining likely sources of information are the
official mobile client's provisioning flow, the adapter's cloud traffic, and
firmware analysis.

## Application implementation status

| Area | Status | Notes |
| --- | --- | --- |
| Web dashboard / PWA | Implemented | Capability-driven overview, grouped controls, visual weekly schedule editing for recognized payloads, waiting state, and responsive desktop/iPhone layouts |
| BRP069A61/A62 local connector | Implemented | `/mca` WebSocket reads, actions, and weekly schedules |
| BRP069A71 identification | Implemented | Safe LAN probe recognizes its cloud-gateway HTTP behavior |
| BRP069A71 UDP discovery | Research tool implemented | Confirms adapter model; not yet a control channel |
| BRP069A71 local state/control | Not discovered | No usable HTTP, WebSocket, or tested UDP control endpoint found |
| ONECTA OAuth connector | Implemented | Token refresh, cached reads, rate-limit tracking, and writes to advertised settable characteristics |
| ONECTA authentication | Connected | OAuth completed through the registered HTTPS callback; API requests succeed |
| ONECTA live heat-pump access | Blocked externally | Authorized account returns zero devices until the gateway is released from the previous account and onboarded |
| Secure internet endpoint | Live | `hp.operagrid.net` resolves to Vercel; TLS and application Basic authentication are verified |
| Always-on hosting | Live | Vercel serves the Node function and PWA; Upstash provides durable encrypted application storage |
| Capability discovery | Implemented | UI exposes only capabilities reported by the selected connector/device |
| Schedule handling | Implemented where advertised | Local A61/A62 schedules; ONECTA activation/selection and visual editing for recognized weekly programmes when the API advertises writes |
| Secure settings storage | Implemented | AES-256-GCM encrypted settings/tokens and a protected generated master key |
| LAN safety | Implemented | Probe targets are restricted to private/link-local IPv4 addresses or `.local` hosts |
| Remote self-hosted access | Supported | Use HTTPS through a reverse proxy or private VPN; never forward the adapter itself |

Known implementation gap: **Disconnect cloud** currently removes the locally
stored OAuth tokens but does not yet call Daikin's token-revocation endpoint.
Until revocation is implemented, consent can be revoked from the ONECTA/Daikin
account when complete server-side revocation is required.

Relevant files:

- `src/connectors/local-altherma.js` — local A61/A62 connector and A71-compatible
  gateway classification;
- `src/connectors/onecta.js` — official ONECTA OAuth/API connector;
- `src/app-handler.js` — HTTP API, connector orchestration, settings, and validation;
- `src/local-server.js` — Mac-only long-running server wrapper;
- `public/app.js` — device, control, schedule, and system UI;
- `scripts/research-a71.mjs` — read-only HTTP/UDP A71 research probe;
- `test/local-altherma.test.js` and `test/onecta.test.js` — connector tests.

## How to reproduce safely

Run the automated checks:

```sh
npm test
npm run check
```

Start the local application:

```sh
APP_PASSWORD='<strong-password>' \
PUBLIC_URL='https://hp.operagrid.net' \
npm start
```

Then open `http://127.0.0.1:8787`.

Daikin does not accept an HTTP loopback callback. For ONECTA OAuth, set
`PUBLIC_URL` to the stable HTTPS origin and register the exact
`https://<host>/oauth/callback` URI in the Daikin developer application. The
Vercel runtime uses the encrypted Redis store and never stores credentials in
its ephemeral filesystem.

Start the configured tunnel in a separate process:

```sh
cloudflared tunnel \
  --config /Users/mafy/dev/pdc_control/.cloudflared/config.yml \
  run
```

Do not add the application password, Daikin client secret, OAuth tokens,
Cloudflare origin certificate, or tunnel credential JSON to source control.

Run the read-only A71 research probe while connected to the same LAN:

```sh
node scripts/research-a71.mjs <adapter-private-ip>
```

The research script sends only the listed HTTP GET and UDP discovery requests.
Its JSON output contains the target IP and the discovery reply's MAC address,
so redact those fields before sharing it.

## Next reverse-engineering work

### Immediate operational work

1. Wait for Daikin support to release the BRP069A71 cloud registration, or
   recover the account/legacy registration that currently owns it.
2. Add the gateway to the same ONECTA account that authorized `pdc_control`.
3. Refresh the dashboard and verify that `/v1/gateway-devices` changes from an
   empty array to the device payload. Save a redacted payload before adding
   model-specific UI assumptions.
4. Verify every reported management point, writable characteristic, schedule,
   range, enum, and unit before performing the first control action.
5. With explicit approval, migrate the existing local ONECTA credentials and
   session to the encrypted hosted store, or reconnect from the hosted UI;
   verify the hosted ONECTA status afterward.
6. Add server-side ONECTA access/refresh-token revocation to **Disconnect
   cloud**.

### Optional BRP069A71 local-protocol research

1. Capture passive network metadata for the adapter at the router: DNS names,
   destination IPs, ports, TLS Server Name Indication, connection timing, and
   behavior during a normal ONECTA action. Avoid publishing credentials or
   tokens.
2. Inspect the official Android ONECTA application's onboarding and local
   provisioning code for BRP069A71-specific paths, request formats, encryption,
   or certificate pinning.
3. Perform a carefully bounded full TCP/UDP service survey if needed, without
   brute-forcing credentials or sending state-changing payloads.
4. Locate legitimate public BRP069A71 firmware/update artifacts and inspect
   them for route names, cloud hostnames, protocol constants, and certificate
   handling.
5. If the A71 is confirmed cloud-only, evaluate a separate local hardware path
   such as the heat-pump service bus/X10A. Projects such as ESPAltherma are
   useful references, but this route generally emphasizes monitoring and
   limited relay/Smart Grid control rather than native schedule editing.

### Constraints and risks

- Cloud traffic is expected to use TLS and may use certificate pinning.
- Replaying a cloud protocol would still depend on Daikin authentication and
  service availability unless a separate local protocol is found.
- Firmware replacement, invasive bus work, or arbitrary control messages can
  disable safety functions, damage equipment, or affect warranty. Those steps
  should not be attempted as exploratory probing.
- The supported remote route remains the official ONECTA API after account
  recovery. The safest fully local fallback may require separate supported
  hardware rather than a software-only change to BRP069A71.

## References

- [Daikin BRP069A71 installer reference guide](https://www.daikin.eu/content/dam/document-library/Installer-reference-guide/ctrl/individual-control-systems/brp069a71/BRP069A71_Installer%20reference%20guide_4PEN624189-1B_English.pdf)
- [Daikin D-series Altherma user reference guide](https://www.daikin.eu/content/dam/document-library/user%20reference%20guide/heat/Air%20to%20water%20heat%20pump%20high%20temperature/ETBH-D6V9W%2CETBX-D6V9W%2CETVH-D6V9WG%2CETVX-D6V9WG_4PEN586456-1B_User%20reference%20guide_English.pdf)
- [Daikin Developer Portal](https://developer.cloud.daikineurope.com/)
- [ESPAltherma](https://github.com/raomin/ESPAltherma)

