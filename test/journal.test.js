import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWeather, heatingDegrees, monthlyDegreeDays, roundCoordinate } from "../src/lib/degree-days.js";
import { emptyJournal, MAX_SAMPLES, mergeConsumption, recordChange, recordSnapshot } from "../src/lib/journal.js";
import { redactPayload } from "../src/lib/redact.js";
import { SecureStore } from "../src/lib/store.js";
import { demoCloudDevice } from "../src/demo.js";

test("snapshots record compact readings and stay within the sample cap", () => {
  const journal = emptyJournal();
  recordSnapshot(journal, [demoCloudDevice], { time: new Date("2026-10-27T10:00:00Z") });
  assert.deepEqual(journal.samples[0], {
    t: "2026-10-27T10:00:00.000Z", o: 6.8, lw: 34.6, r: 21.4, tk: 48.2, rt: 21.5, off: 0, tt: 50,
    m: "heating", cs: "heating", ts: "idle", cp: true, tp: true,
  });
  journal.samples = Array.from({ length: MAX_SAMPLES }, () => ({ t: "old" }));
  recordSnapshot(journal, [demoCloudDevice], { time: new Date("2026-10-27T10:00:00Z") });
  assert.equal(journal.samples.length, MAX_SAMPLES);
  assert.notEqual(journal.samples.at(-1).t, "old");
});

test("weekly and monthly consumption arrays map onto calendar dates", () => {
  const device = { points: [{ id: "c", type: "climateControl", characteristics: [{ name: "consumptionData", leaves: [
    { path: "/electrical/heating/w", value: [1, 2, 3, 4, 5, 6, 7, 8, 9, null, null, null, null, null] },
    { path: "/electrical/heating/m", value: [...Array(12).fill(10), 20, 30, ...Array(10).fill(null)] },
  ] }] }] };
  // Wednesday 2026-01-14: last week's Monday is 2026-01-05.
  const journal = mergeConsumption(emptyJournal(), [device], "2026-01-14");
  assert.deepEqual(journal.daily["2026-01-05"], { heat: 1 });
  assert.deepEqual(journal.daily["2026-01-13"], { heat: 9 });
  assert.equal(journal.daily["2026-01-14"], undefined, "no figure reported for today yet");
  assert.deepEqual(journal.monthly["2025-12"], { heat: 10 });
  assert.deepEqual(journal.monthly["2026-02"], undefined);
  assert.deepEqual(journal.monthly["2026-01"], { heat: 20 });
});

test("the change log is capped", () => {
  const journal = emptyJournal();
  for (let index = 0; index < 510; index += 1) recordChange(journal, { setting: "x", to: index });
  assert.equal(journal.changes.length, 500);
  assert.equal(journal.changes.at(-1).to, 509);
});

test("degree-days use a 15.5 °C base and group by month", () => {
  assert.equal(heatingDegrees(5.5), 10);
  assert.equal(heatingDegrees(20), 0);
  assert.deepEqual(monthlyDegreeDays({ "2026-01-01": 0.5, "2026-01-02": 5.5, "2026-02-01": 16 }), {
    "2026-01": { hdd: 25, days: 2, mean: 3 },
    "2026-02": { hdd: 0, days: 1, mean: 16 },
  });
  assert.equal(roundCoordinate(46.7712), 46.8);
});

test("weather is fetched with rounded coordinates and cached for the day", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    return new Response(JSON.stringify({ daily: { time: ["2026-10-20", "2026-10-26", "2026-10-27"], temperature_2m_mean: [8, 6, 5] } }));
  };
  const journal = emptyJournal();
  const now = new Date("2026-10-27T12:00:00Z");
  assert.equal(await ensureWeather(journal, { latitude: 46.7712, longitude: 23.6236, timeZone: "UTC" }, { now, fetchImpl }), true);
  assert.equal(urls.length, 2);
  for (const url of urls) {
    assert.equal(url.searchParams.get("latitude"), "46.8");
    assert.equal(url.searchParams.get("longitude"), "23.6");
  }
  assert.equal(urls[0].searchParams.get("start_date"), "2024-10-01");
  assert.equal(journal.weather.daily["2026-10-26"], 6);
  assert.equal(journal.weather.daily["2026-10-27"], undefined, "today is incomplete and is not stored");
  assert.equal(await ensureWeather(journal, { latitude: 46.7712, longitude: 23.6236, timeZone: "UTC" }, { now, fetchImpl }), false);
  assert.equal(urls.length, 2);
});

test("weather failures surface as errors without partial state", async () => {
  const journal = emptyJournal();
  const fetchImpl = async () => new Response(JSON.stringify({ reason: "bad request" }), { status: 400 });
  await assert.rejects(() => ensureWeather(journal, { latitude: 1, longitude: 2 }, { fetchImpl }), /bad request/);
  assert.equal(journal.weather.fetchedOn, null);
});

test("redaction removes identifiers but keeps readings", () => {
  const raw = [{
    id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    deviceModel: "Altherma",
    managementPoints: [
      { embeddedId: "gateway", managementPointType: "gateway", serialNumber: { value: "SN12345" }, macAddress: { value: "aa:bb:cc:dd:ee:ff" }, ipAddress: { value: "192.168.1.20" }, ssid: { value: "Home" }, name: { value: "Kitchen", settable: true } },
      { embeddedId: "climateControl", sensoryData: { value: { roomTemperature: { value: 21.4, unit: "°C" } } }, note: "owner contact x@example.com" },
    ],
  }];
  const redacted = JSON.stringify(redactPayload(raw));
  for (const secret of ["0f1e2d3c", "SN12345", "aa:bb:cc", "192.168", "Kitchen", "x@example.com", "\"Home\""]) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.ok(redacted.includes("21.4"));
  assert.ok(redacted.includes("\"embeddedId\":\"climateControl\""));
  assert.ok(redacted.includes("\"settable\":true"));
});

test("a second secure store keeps its own file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
  try {
    const settings = new SecureStore(directory, "secret-for-tests");
    const journal = new SecureStore(directory, "secret-for-tests", "journal.enc.json");
    await settings.init();
    await journal.init();
    await settings.write({ a: 1 });
    await journal.write({ b: 2 });
    assert.deepEqual(await settings.read(), { a: 1 });
    assert.deepEqual(await journal.read(), { b: 2 });
    assert.deepEqual((await fs.readdir(directory)).sort(), ["journal.enc.json", "settings.enc.json"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
