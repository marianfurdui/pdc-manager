import test from "node:test";
import assert from "node:assert/strict";
import { classifyCloudGatewayHttp, marshallSchedule, summarizeA71Response, unmarshallSchedule, validateLocalHost } from "../src/connectors/local-altherma.js";

test("local host validation accepts only private targets", () => {
  assert.equal(validateLocalHost("192.168.1.42"), "192.168.1.42");
  assert.equal(validateLocalHost("daikin.local:80"), "daikin.local:80");
  assert.throws(() => validateLocalHost("8.8.8.8"), /private LAN/);
  assert.throws(() => validateLocalHost("example.com"), /private LAN/);
});

test("space schedule round-trips through the adapter encoding", () => {
  const schedule = {
    monday: [{ time: "06:00", value: 20.5 }, { time: "22:30", value: 18 }],
    tuesday: [{ time: "07:15", value: 21 }],
  };
  const encoded = marshallSchedule(schedule, "space");
  assert.match(encoded, /^\$NULL\|1\|0600,205;2230,180;/);
  const decoded = unmarshallSchedule(encoded, "space");
  assert.deepEqual(decoded.monday, schedule.monday);
  assert.deepEqual(decoded.tuesday, schedule.tuesday);
  assert.deepEqual(decoded.wednesday, []);
});

test("schedule rejects more than six changes per day", () => {
  const monday = Array.from({ length: 7 }, (_, index) => ({ time: `0${index}:00`, value: 20 }));
  assert.throws(() => marshallSchedule({ monday }), /more than 6/);
});

test("tank schedules encode semantic modes", () => {
  const encoded = marshallSchedule({ sunday: [{ time: "05:30", value: "comfort" }, { time: "09:00", value: "eco" }] }, "tank");
  const decoded = unmarshallSchedule(encoded, "tank");
  assert.deepEqual(decoded.sunday, [{ time: "05:30", value: "comfort" }, { time: "09:00", value: "eco" }]);
});

test("cloud-only Daikin HTTP service is reported as reachable without claiming control", () => {
  assert.deepEqual(classifyCloudGatewayHttp(404, "File / not_found", 404, "File /common/basic_info not_found"), {
    protocol: "daikin-cloud-gateway-http",
    adapterModel: "BRP069A71-compatible gateway",
    localControl: false,
    note: "The gateway is reachable on the LAN, but it does not expose a local heat-pump status or control API.",
  });
  assert.equal(classifyCloudGatewayHttp(200, "OK", 404, "not_found"), null);
});

test("A71 setup responses expose structure without values", () => {
  const summary = summarizeA71Response("/common/basic_info", 200, "text/plain; charset=utf-8", "ret=OK,ssid=PrivateNetwork,mac=001122334455,registered=true,owner=secret-user");
  assert.equal(summary.path, "/common/basic_info");
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.keys, ["ret", "ssid", "mac", "registered", "owner"]);
  assert.ok(summary.markers.includes("registered"));
  assert.ok(summary.markers.includes("owner"));
  assert.equal(JSON.stringify(summary).includes("PrivateNetwork"), false);
  assert.equal(JSON.stringify(summary).includes("secret-user"), false);
});

test("A71 setup summaries ignore a generic 404's echoed request path", () => {
  const root = summarizeA71Response("/", 404, "text/plain", "File / not_found");
  const wifi = summarizeA71Response("/config/wlan/networks", 404, "text/plain", "File /config/wlan/networks not_found");
  assert.equal(wifi.fingerprint, root.fingerprint);
  assert.deepEqual(wifi.markers, []);
});

test("A71 setup summaries expose only allowlisted non-identifying values", () => {
  const summary = summarizeA71Response("/config/adapter/info", 200, "application/json", JSON.stringify({
    udid: "private-id",
    gatewayDeviceId: "private-gateway-id",
    macAddress: "001122334455",
    ipAddress: "192.168.1.42",
    status: "Connected",
    udpDiscovery: true,
  }));
  assert.deepEqual(summary.details, { status: "Connected", udpDiscovery: true, cloudIdentityPresent: true });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("private-id"), false);
  assert.equal(serialized.includes("001122334455"), false);
  assert.equal(serialized.includes("192.168.1.42"), false);
});
