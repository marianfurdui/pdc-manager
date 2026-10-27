# Altherma Control

A self-hosted dashboard for Daikin Altherma heat pumps. For the installed
**BRP069A71**, the primary connection is the official ONECTA cloud. The project
also contains an optional local connector for compatible LAN adapters.

It provides:

- local read/control for Altherma **BRP069A61/A62** adapters through the `/mca` WebSocket API;
- local weekly space-heating and tank schedule reading/writing;
- optional remote read/control through Daikin's official **ONECTA Cloud API**;
- capability discovery: the cloud UI only enables values that the unit reports as settable;
- encrypted-at-rest settings and tokens, API request validation, local-address-only probing, and optional HTTP Basic authentication;
- an installable responsive PWA with no runtime npm dependencies.

## Current installation status

As of 2026-10-27, the application stack is functional and its always-on Vercel
deployment is live:

- local dashboard: `http://127.0.0.1:8787`;
- production dashboard: `https://hp.operagrid.net` (Cloudflare DNS, Vercel
  custom domain, TLS, Basic authentication, and callback routing verified);
- remote dashboard authentication: enabled;
- ONECTA OAuth: connected and tokens stored encrypted;
- ONECTA API transport: working;
- devices returned by the authorized ONECTA account: **zero**.

The remaining blocker is outside the application: the BRP069A71 still reports
`ALREADY_REGISTERED_TO_OTHER` during onboarding. Daikin must release that cloud
registration, or the owning legacy account must be recovered, before the
gateway can be added to the authorized ONECTA account. Once that happens, use
**Refresh** in the dashboard; no connector rewrite or new OAuth authorization
should be necessary unless Daikin revokes the existing consent.

The Mac runtime remains useful for LAN-only diagnostics. The hosted runtime is
ONECTA-only, because a Vercel function cannot reach the private home network.
See
[`RESEARCH_STATUS.md`](RESEARCH_STATUS.md) for the verified network evidence,
deployment context, exact implementation status, known gaps, and next steps.

## Your hardware: BRP069A71

The supplied front and rear photos identify the installed adapter as:

| Item | Identified value |
| --- | --- |
| Heat pump | Daikin Altherma 3 H HT reversible |
| Indoor unit | `ETVX16S23D9W`, 230 L hydrotank |
| Outdoor unit | `EPRA14DW1`, 14 kW, three phase |
| Wi-Fi controller | **BRP069A71** |
| Controller type | Daikin `WLAN module heating` |
| Normal control path | BRP069A71 → internet → ONECTA Cloud API → this application |

The photographed serial number, MAC address and QR code are deliberately not
copied into this repository.

The **BRP069A71** is the optional Wi-Fi module whose documented purpose is
connecting the heat pump to Daikin Cloud for ONECTA. It is not a BRP069A61/A62
LAN adapter, which is the adapter family on which the local `/mca` WebSocket
protocol has been demonstrated.

### What the photographed lights mean

The photo shows the **RUN** indicator illuminated and the **AP** indicator off.
According to the BRP069A71 guide:

- **RUN on:** the adapter is operating as a Wi-Fi station and is connected to a
  network. This confirms the home Wi-Fi connection, but does not prove that the
  adapter is registered to a working ONECTA account.
- **AP off:** the temporary `daikin-ap` onboarding network is not currently
  active.
- **SETUP:** starts router setup.
- **MODE:** hold to toggle access-point mode for ONECTA onboarding.
- **POWER:** restarts/resets the WLAN adapter; it does not replace the indoor
  controller's separate “Remove from cloud” operation.

### Controller compatibility

| Controller | Direct local reads/actions | ONECTA remote access | This application |
| --- | --- | --- | --- |
| **BRP069A71 (installed)** | No documented `/mca` control API | Yes | Cloud connector; safe LAN probe for confirmation |
| BRP069A61/A62 LAN adapter | Yes, `/mca` WebSocket | Depends on adapter firmware/configuration | Full local reader, actions and schedules |

The app includes a safe local probe because firmware varies, but a failed probe
is expected for BRP069A71 and cannot be corrected by application software.
The probe does not change adapter or heat-pump settings.

The supplied unit was tested on its home LAN: the gateway answers on HTTP port
80, but the Altherma `/mca`, legacy `/common/*` and `/aircon/*`, and newer
`/dsiot/multireq` status/control endpoints are absent. The application recognizes
this response as a reachable cloud gateway and reports it without falsely
claiming local control.

Offline local control would require one of:

1. a compatible BRP069A61/A62 LAN adapter, if supported by the indoor unit and installer configuration;
2. a dedicated hardware interface to the unit bus/service port (an advanced installation);
3. keeping BRP069A71 and using ONECTA through the official cloud API.

Do not expose the adapter itself to the internet.

## Recover or migrate the old account first

First identify which older application was used:

- **Daikin Residential Controller:** use the existing Daikin ID in ONECTA. If
  ONECTA says the email already exists, choose **Sign in**, not **Create
  account**. Use the same Apple/Google/email method, or **Forgot password** for
  an email login.
- **Daikin Online Controller (DOC):** its devices do not automatically appear
  in ONECTA. Sign in or create the required Daikin ID, then manually onboard the
  unit while at home.

For this BRP069A71 installation:

1. Be at home and connected to the same home Wi-Fi network as the heat pump.
2. In ONECTA choose **+ → Add device** and select the Altherma/wireless-gateway
   flow.
3. When ONECTA asks for access-point mode, hold **MODE** on BRP069A71 until the
   AP indicator flashes. Join `daikin-ap` when prompted and remain connected
   even if iOS says the network has no internet.
4. If ONECTA reports `ALREADY_REGISTERED_TO_OTHER`, do not assume that the
   indoor controller has a **Remove from cloud** command. On this D-series
   ETVX controller, the documented gateway menu is `[D.1] Mode`, `[D.2] WPS`,
   `[D.3] Reset`, and `[D.4] Device info`; the remove-from-cloud entry belongs
   to newer controller generations. Expand ONECTA's **How do I remove my
   gateway...** instructions for the firmware-specific procedure. If the old
   account cannot be recovered and ONECTA does not provide a local release
   procedure, send **Share diagnostics** to Daikin support so they can verify
   ownership and release the gateway.
5. Do **not** factory-reset the complete heat pump and do not expose the
   BRP069A71 IP address directly to the internet.

Official references: [ONECTA migration guide](https://www.daikin.eu/en_us/faq/getting-started-with-onecta.html), [BRP069A71 reference guide](https://www.daikin.eu/content/dam/document-library/Installer-reference-guide/ctrl/individual-control-systems/brp069a71/BRP069A71_Installer%20reference%20guide_4PEN624189-1B_English.pdf), and [Daikin ID account linking](https://id.daikin.eu/info/no/faq/faq3.html).

## Run it

Requires Node.js 22 or newer; Node.js 24 is recommended.

```sh
npm test
npm start
```

Open `http://127.0.0.1:8787`. No dependencies need to be installed.

For a populated preview without hardware:

```sh
DEMO_MODE=true npm start
```

### LAN access

The default bind is loopback-only. To open it to your home network, an application password is mandatory:

```sh
HOST=0.0.0.0 APP_PASSWORD='use-a-long-unique-password' npm start
```

Then visit `http://<computer-ip>:8787`. The username in the browser's Basic Auth dialog can be anything; the password must match `APP_PASSWORD`.

### Docker

Edit `APP_PASSWORD` in `compose.yaml`, then:

```sh
docker compose up -d --build
```

The example binds only to loopback. Put it behind an HTTPS reverse proxy or a private overlay VPN to reach it remotely.

## ONECTA remote access

1. Recover/onboard the heat pump in ONECTA.
2. Sign into the [Daikin Developer Portal](https://developer.cloud.daikineurope.com/login) with the **same account and login method**.
3. Create a personal application.
4. Give this application a stable public HTTPS origin. Daikin does not accept
   an `http://` callback and explicitly disallows `https://localhost`.
5. Set `PUBLIC_URL` to that HTTPS origin, restart the server, open **System**,
   save the client ID and secret, and copy the exact redirect URI into the
   Daikin application.
6. The Daikin developer portal may show **No Products** for the application;
   current Daikin documentation says registering an API product is not
   required.
7. Press **Connect Daikin account**.

For non-localhost or reverse-proxy deployments, set an HTTPS public base URL:

```sh
PUBLIC_URL='https://heat.example.net' APP_PASSWORD='...' npm start
```

The callback registered at Daikin is then
`https://heat.example.net/oauth/callback`. It must match exactly.

This installation uses `https://hp.operagrid.net`; the exact registered
callback is `https://hp.operagrid.net/oauth/callback`. With explicit user
approval, the existing ONECTA client configuration and refresh session were
migrated from the Mac into the encrypted hosted store; private LAN settings and
transient OAuth/cache data were excluded. The authorized account will continue
to return no gateway devices while BRP069A71 remains assigned to the previous
account.

The repository includes a Vercel entry point and an AES-256-GCM encrypted
Redis store for settings, OAuth PKCE state, tokens, and the short-lived device
cache. The hosted runtime deliberately disables LAN probing and local adapter
control; use the Mac runtime when those features are needed.

### Vercel environment

Production requires these environment variables:

- `PUBLIC_URL=https://hp.operagrid.net`
- `APP_PASSWORD` — protects the entire dashboard with HTTP Basic auth
- `APP_SECRET` — stable encryption key material of at least 32 characters
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or the compatible
  `KV_REST_API_URL` and `KV_REST_API_TOKEN` names supplied by the storage
  integration)

Do not place any of these values in Git. The GitHub repository contains code
and documentation only.

ONECTA has a low personal API quota (Daikin currently documents 200 calls/day). The connector caches reads for eight minutes, tracks the returned rate-limit headers, refreshes OAuth tokens, and invalidates state after writes.

## Supported operations

Local BRP069A61/A62:

- read indoor/outdoor/leaving-water/tank temperatures;
- read control mode, operating mode, activity, warning/error state, versions and consumption;
- turn space conditioning on/standby;
- set room target and weather-curve leaving-water offset;
- set tank target and powerful mode;
- read and replace weekly space/tank schedules (maximum six changes/day).

ONECTA:

- reads every gateway device and management point returned by `/v1/gateway-devices`;
- turns returned readings into an Altherma-oriented overview and groups controls
  by climate zone, hot-water tank, and other management points;
- PATCHes only characteristics/leaves advertised as `settable`;
- supports ONECTA schedule `PUT` resources when advertised by the device;
- provides a day/time/temperature editor for weekly schedule shapes it can
  recognize safely, while leaving unknown schedule formats read-only;
- adapts to a 16-inch MacBook layout and an iPhone 11 Pro touch layout.
- shows a read-only Wi-Fi gateway reachability check under **System**, with the
  last successful result stored locally.

Energy review (read-only):

- **System → Your home** stores the home profile (location, floor
  area, occupants, preferred temperatures, emitters, tariff, solar,
  insulation) in the encrypted settings;
- **Home → Ways to use less energy** lists findings from
  `src/lib/efficiency.js` with evidence and estimated savings, plus heating
  kWh per degree-day. It is built from already-fetched data and never spends
  ONECTA quota;
- history (readings, daily/monthly kWh, weather, and setting changes) is kept
  in a separate encrypted journal: `data/journal.enc.json` locally, the
  `pdc-control:journal` Redis key when hosted;
- past daily outdoor temperatures come from Open-Meteo using only the
  location rounded to 0.1° (the profile keeps up to 8 decimals) and the
  house altitude, and about 30 days of hourly temperatures are matched
  against the heat pump's outdoor sensor as a cross-check;
- `node scripts/efficiency-audit.mjs` runs the day-one review (one ONECTA
  request, redacted payload saved under `data/audits/`).

See [`docs/EFFICIENCY_PLAYBOOK.md`](docs/EFFICIENCY_PLAYBOOK.md) for the
reasoning, the installer-menu checklist and the change protocol.

Actual availability is determined by the unit firmware, hydraulic/control configuration, and public API scope. A feature visible in ONECTA's official app may be absent from the public API.

## Security and deployment notes

- Secrets and tokens are stored in AES-256-GCM encrypted `data/settings.enc.json`; the generated `data/.master-key` is mode `0600`. Back up both or set a stable `APP_SECRET`.
- The server refuses `HOST=0.0.0.0` without `APP_PASSWORD`.
- Local probes accept only RFC1918/link-local IPv4 addresses or `.local` names.
- Remote internet access should use HTTPS behind a reverse proxy or a private VPN such as Tailscale. Never port-forward the heat pump/WLAN adapter.
- The production hostname routes only to the Vercel application. It does not
  route to the BRP069A71, the Mac, or any other LAN device.
- `.cloudflared/`, `data/`, Daikin credentials/tokens, application passwords,
  and Cloudflare credential files must remain outside source control.
- **Disconnect cloud** currently deletes the local tokens. Until server-side
  token revocation is implemented, revoke consent in the ONECTA/Daikin account
  when complete revocation is required.
- The project is independent and is not affiliated with Daikin.
