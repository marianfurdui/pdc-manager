#!/usr/bin/env node
// Day-one energy review. Read-only: makes one ONECTA device request (it
// counts against the daily quota), saves a redacted copy of the payload for
// review, records it in the journal and prints the findings.
//
//   node scripts/efficiency-audit.mjs            # uses ./data
//   DATA_DIR=/path node scripts/efficiency-audit.mjs
//
// The saved file under data/audits/ has identifiers removed but still
// describes your installation; data/ is never committed.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCloudDevices, OnectaConnector } from "../src/connectors/onecta.js";
import { ensureWeather } from "../src/lib/degree-days.js";
import { evaluate, INSTALLER_CHECKLIST } from "../src/lib/efficiency.js";
import { localDate, normalizeJournal, recordSnapshot } from "../src/lib/journal.js";
import { redactPayload } from "../src/lib/redact.js";
import { SecureStore } from "../src/lib/store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const store = new SecureStore(dataDirectory, process.env.APP_SECRET);
const journalStore = new SecureStore(dataDirectory, process.env.APP_SECRET, "journal.enc.json");
await store.init();
await journalStore.init();

const settings = await store.read();
if (!settings.onecta?.tokens) {
  console.error("No Daikin session in this data directory. Connect ONECTA in the dashboard first.");
  process.exit(1);
}
const house = settings.house || {};
const cloud = new OnectaConnector(() => store.read(), (value) => store.write(value));
const raw = await cloud.devices(true);
const devices = normalizeCloudDevices(raw);
if (!devices.length) {
  console.log("Daikin still lists no heat pump for this account. Nothing to review yet.");
  process.exit(0);
}

const now = new Date();
const audits = path.join(dataDirectory, "audits");
await fs.mkdir(audits, { recursive: true, mode: 0o700 });
const file = path.join(audits, `${localDate(now, house.timeZone)}.json`);
await fs.writeFile(file, `${JSON.stringify(redactPayload(raw), null, 2)}\n`, { mode: 0o600 });

const journal = normalizeJournal(await journalStore.read());
recordSnapshot(journal, devices, { time: now, timeZone: house.timeZone });
let weatherNote = "";
if (Number.isFinite(house.latitude) && Number.isFinite(house.longitude)) {
  try {
    await ensureWeather(journal, house, { now });
  } catch (error) {
    weatherNote = `Weather history unavailable: ${error.message}`;
  }
} else {
  weatherNote = "No location in the home profile, so consumption is not weather-normalised.";
}
await journalStore.write(journal);

const { findings, stats } = evaluate({ devices, house, journal, now });
const points = devices.flatMap((device) => device.points.map((point) => `${point.type}${point.schedule ? " (schedule)" : ""}: ${point.characteristics.map((item) => item.name).join(", ")}`));
const missingProfile = ["latitude", "longitude", "area", "occupants", "dayTemp"].filter((key) => !Number.isFinite(house[key]));

console.log(`Redacted payload: ${path.relative(root, file)}`);
console.log(`Rate limit: ${JSON.stringify(cloud.rateLimit)}`);
console.log(`\nManagement points\n${points.map((line) => `  - ${line}`).join("\n")}`);
console.log(`\nFindings (${findings.length})`);
for (const item of findings) {
  console.log(`  [${item.severity}] ${item.title}\n      ${item.evidence}\n      ${item.suggestion}${item.estimate ? `\n      Estimate: ${item.estimate}` : ""}`);
}
const usable = stats.filter((month) => month.kwhPerHdd !== null);
console.log(`\nMonths with kWh per degree-day: ${usable.length}${usable.length ? ` (latest ${usable.at(-1).month}: ${usable.at(-1).kwhPerHdd})` : ""}`);
if (weatherNote) console.log(weatherNote);
if (missingProfile.length) console.log(`Home profile is missing: ${missingProfile.join(", ")}`);
console.log(`\nStill needed from the indoor unit's installer menu:\n${INSTALLER_CHECKLIST.map((line) => `  - ${line}`).join("\n")}`);
