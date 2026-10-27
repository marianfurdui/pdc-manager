import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequestHandler, sanitizeHouse } from "../src/app-handler.js";

function memoryStore(initial = {}) {
  let value = structuredClone(initial);
  return { async init() {}, async read() { return structuredClone(value); }, async write(next) { value = structuredClone(next); } };
}

async function serve(options) {
  const server = http.createServer(await createRequestHandler(options));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("house profiles keep known fields and round coordinates", () => {
  assert.deepEqual(sanitizeHouse({ latitude: "46.771234567", longitude: 23.6236, area: "140", emitters: "underfloor", tariff: "flat", timeZone: "Europe/Bucharest", extra: "dropped", occupants: "" }), {
    latitude: 46.77123457, longitude: 23.6236, area: 140, emitters: "underfloor", tariff: "flat", timeZone: "Europe/Bucharest",
  });
  assert.throws(() => sanitizeHouse({ dayTemp: 40 }), /dayTemp/);
  assert.throws(() => sanitizeHouse({ emitters: "stove" }), /emitters/);
  assert.equal(sanitizeHouse({ roomThermostats: "some" }).roomThermostats, "some");
  assert.equal(sanitizeHouse({ elevation: "412" }).elevation, 412);
  assert.equal(sanitizeHouse({ basementTemp: "13.5" }).basementTemp, 13.5);
  assert.deepEqual(sanitizeHouse({ rooms: [{ name: " Dressing ", area: "6.04", target: "15.2" }, { name: "", area: "", target: "" }] }).rooms, [{ name: "Dressing", area: 6, day: 15 }], "the old single temperature becomes day");
  assert.deepEqual(sanitizeHouse({ rooms: [{ name: "Bedroom", area: 16, day: "21", night: "18.5" }, { name: "Bath", area: 7, day: 19, night: "" }] }).rooms, [{ name: "Bedroom", area: 16, day: 21, night: 18.5 }, { name: "Bath", area: 7, day: 19 }]);
  assert.throws(() => sanitizeHouse({ rooms: [{ name: "Hall", area: 10, day: 20, night: 40 }] }), /Room 1: night/);
  assert.equal(sanitizeHouse({ rooms: [{ name: "", area: "", target: "" }] }).rooms, undefined);
  assert.throws(() => sanitizeHouse({ rooms: [{ name: "Hall", area: "", target: 20 }] }), /Room 1: area/);
  assert.throws(() => sanitizeHouse({ rooms: [{ name: "Hall", area: 10, target: 40 }] }), /Room 1: day/);
  assert.throws(() => sanitizeHouse({ timeZone: "Mars/Olympus" }), /time zone/);
});

test("the house profile is saved through settings", async () => {
  const store = memoryStore();
  const server = await serve({ store });
  try {
    const response = await fetch(`${server.url}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ house: { area: 120, dayTemp: 21 } }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).house, { area: 120, dayTemp: 21 });
    assert.deepEqual((await store.read()).house, { area: 120, dayTemp: 21 });
  } finally {
    await server.close();
  }
});

test("efficiency in demo mode returns findings without touching Daikin", async () => {
  const originalFetch = globalThis.fetch;
  const server = await serve({ store: memoryStore(), journalStore: memoryStore(), demoMode: true });
  const outbound = [];
  try {
    globalThis.fetch = async (url, options) => {
      if (!String(url).startsWith(server.url)) outbound.push(String(url));
      return originalFetch(url, options);
    };
    const result = await (await fetch(`${server.url}/api/efficiency`)).json();
    assert.ok(result.findings.some((item) => item.id === "water-too-hot"));
    assert.ok(result.stats.length > 0);
    assert.equal(result.profileComplete, false);
    assert.ok(result.installerChecklist.length > 0);
    assert.deepEqual(outbound, []);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
  }
});

test("set-aside suggestions are saved and flagged", async () => {
  const server = await serve({ store: memoryStore(), journalStore: memoryStore(), demoMode: true });
  try {
    const put = (setAside) => fetch(`${server.url}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ setAside }) });
    assert.equal((await put(["deep-setback", "deep-setback"])).status, 200);
    assert.equal((await put(["<script>"])).status, 400);
    const settings = await (await fetch(`${server.url}/api/settings`)).json();
    assert.deepEqual(settings.setAside, ["deep-setback"]);
    const { findings } = await (await fetch(`${server.url}/api/efficiency`)).json();
    assert.equal(findings.find((item) => item.id === "deep-setback").setAside, true);
    assert.equal(findings.find((item) => item.id === "water-too-hot").setAside, undefined);
  } finally {
    await server.close();
  }
});

test("efficiency without a connection or history is empty, not an error", async () => {
  const server = await serve({ store: memoryStore(), journalStore: memoryStore() });
  try {
    const response = await fetch(`${server.url}/api/efficiency`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.findings, []);
    assert.equal(result.samples, 0);
  } finally {
    await server.close();
  }
});

test("hosted runtime refuses A71 LAN inspection", async () => {
  const server = await serve({ store: memoryStore(), localEnabled: false, runtime: "vercel" });
  try {
    const response = await fetch(`${server.url}/api/local/a71-inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "LOCAL_NETWORK_REQUIRED");
  } finally {
    await server.close();
  }
});
