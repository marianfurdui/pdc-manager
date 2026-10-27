import crypto from "node:crypto";
import { AppError } from "../lib/errors.js";
import { fetchWithTimeout } from "../lib/http.js";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SHORT_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const A71_READ_ONLY_PATHS = [
  "/config/adapter/info",
  "/config/adapter/product_info",
  "/config/firmware/info",
  "/config/wlan/info",
  "/config/wlan/networks",
  "/",
  "/common/basic_info",
];
const A71_MARKERS = ["wifi", "network", "cloud", "registration", "registered", "owner", "device", "firmware", "setup", "provision", "gateway", "websocket"];

const READERS = {
  model: "1/UnitInfo/ModelNumber/la",
  unitType: "1/UnitInfo/UnitType/la",
  indoorSoftware: "1/UnitInfo/Version/IndoorSoftware/la",
  outdoorSoftware: "1/UnitInfo/Version/OutdoorSoftware/la",
  controlMode: "1/UnitStatus/ControlModeState/la",
  spacePower: "1/Operation/Power/la",
  operationMode: "1/Operation/OperationMode/la",
  indoorTemperature: "1/Sensor/IndoorTemperature/la",
  outdoorTemperature: "1/Sensor/OutdoorTemperature/la",
  leavingWaterTemperature: "1/Sensor/LeavingWaterTemperatureCurrent/la",
  targetTemperature: "1/Operation/TargetTemperature/la",
  leavingWaterOffset: "1/Operation/LeavingWaterTemperatureOffsetHeating/la",
  spaceActive: "1/UnitStatus/ActiveState/la",
  spaceError: "1/UnitStatus/ErrorState/la",
  spaceWarning: "1/UnitStatus/WarningState/la",
  holiday: "1/Holiday/HolidayState/la",
  tankPower: "2/Operation/Power/la",
  tankTemperature: "2/Sensor/TankTemperature/la",
  tankTargetTemperature: "2/Operation/TargetTemperature/la",
  tankPowerful: "2/Operation/Powerful/la",
  tankActive: "2/UnitStatus/ActiveState/la",
  tankError: "2/UnitStatus/ErrorState/la",
  tankWarning: "2/UnitStatus/WarningState/la",
  spaceConsumption: "1/Consumption/la",
  tankConsumption: "2/Consumption/la",
  spaceSchedule: "1/Schedule/List/Heating/la",
  tankSchedule: "2/Schedule/List/Heating/la",
  nextSpaceSchedule: "1/Schedule/Next/la",
  nextTankSchedule: "2/Schedule/Next/la",
};

const WRITERS = {
  "space.power": { item: "1/Operation/Power", transform: (v) => (toBool(v) ? "on" : "standby") },
  "space.targetTemperature": { item: "1/Operation/TargetTemperature", transform: (v) => finiteRange(v, 5, 40) },
  "space.leavingWaterOffset": { item: "1/Operation/LeavingWaterTemperatureOffsetHeating", transform: (v) => finiteRange(v, -10, 10) },
  "space.holiday": { item: "1/Holiday/HolidayState", transform: (v) => Number(toBool(v)) },
  "tank.powerful": { item: "2/Operation/Powerful", transform: (v) => Number(toBool(v)) },
  "tank.targetTemperature": { item: "2/Operation/TargetTemperature", transform: (v) => finiteRange(v, 30, 65) },
};

function toBool(value) {
  if (value === true || value === "true" || value === "on" || value === 1) return true;
  if (value === false || value === "false" || value === "off" || value === 0) return false;
  throw new AppError("Expected an on/off value", 400, "INVALID_VALUE");
}

function finiteRange(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new AppError(`Value must be between ${min} and ${max}`, 400, "INVALID_VALUE");
  }
  return number;
}

export function validateLocalHost(input) {
  const raw = String(input || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const [host, port] = raw.split(":");
  const parts = host.split(".").map(Number);
  const privateV4 = parts.length === 4 && parts.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) && (
    parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 169 && parts[1] === 254)
  );
  const localName = /^[a-z0-9][a-z0-9-]{0,62}\.local$/i.test(host);
  const validPort = port === undefined || (/^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535);
  if ((!privateV4 && !localName) || !validPort) {
    throw new AppError("Use a private LAN IP address or a .local hostname", 400, "INVALID_LOCAL_HOST");
  }
  return port ? `${host}:${port}` : host;
}

function valueAt(object, path) {
  return path.split("/").filter(Boolean).reduce((value, key) => value?.[key], object);
}

function unwrap(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.startsWith("{") || text.startsWith("[") || text === "true" || text === "false" || text === "null") {
    try { return JSON.parse(text); } catch { /* keep text */ }
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return value;
}

class McaSession {
  constructor(host, timeoutMs = 3_500) {
    this.host = validateLocalHost(host);
    this.timeoutMs = timeoutMs;
    this.socket = null;
  }

  async connect() {
    if (typeof WebSocket === "undefined") throw new AppError("This Node.js version does not include WebSocket support", 500, "WEBSOCKET_UNAVAILABLE");
    this.socket = new WebSocket(`ws://${this.host}/mca`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError("The adapter did not open its local /mca API", 504, "LOCAL_TIMEOUT")), this.timeoutMs);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new AppError("No compatible /mca WebSocket API was found", 502, "LOCAL_API_UNAVAILABLE")); }, { once: true });
    });
  }

  async request(item, payload = undefined, outputPath = "/m2m:rsp/pc/m2m:cin/con") {
    const id = crypto.randomBytes(4).toString("hex").slice(0, 5);
    const request = { "m2m:rqp": { fr: "altherma-control", rqi: id, op: 2, to: `/[0]/MNAE/${item}` } };
    if (payload !== undefined) Object.assign(request["m2m:rqp"], { ty: 4, op: 1, pc: { "m2m:cin": { con: payload, cnf: "text/plain:0" } } });
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError(`Timed out reading ${item}`, 504, "LOCAL_TIMEOUT")), this.timeoutMs);
      const onMessage = (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message?.["m2m:rsp"]?.rqi !== id) return;
        clearTimeout(timer);
        this.socket.removeEventListener("message", onMessage);
        resolve(message);
      };
      this.socket.addEventListener("message", onMessage);
      this.socket.send(JSON.stringify(request));
    });
    const status = Number(response?.["m2m:rsp"]?.rsc || 0);
    if (status >= 4000) throw new AppError(`Adapter rejected ${item}`, 502, "LOCAL_COMMAND_REJECTED", { adapterStatus: status });
    return unwrap(valueAt(response, outputPath));
  }

  async adapterInfo() {
    const id = crypto.randomBytes(4).toString("hex").slice(0, 5);
    const request = { "m2m:rqp": { fr: "altherma-control", rqi: id, op: 2, to: "/[0]/MNCSE-node/deviceInfo" } };
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError("Adapter information timed out", 504, "LOCAL_TIMEOUT")), this.timeoutMs);
      const listener = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message?.["m2m:rsp"]?.rqi !== id) return;
          clearTimeout(timer); this.socket.removeEventListener("message", listener); resolve(message);
        } catch { /* ignore unrelated frames */ }
      };
      this.socket.addEventListener("message", listener);
      this.socket.send(JSON.stringify(request));
    });
    return valueAt(response, "/m2m:rsp/pc/m2m:dvi") || {};
  }

  close() { if (this.socket) this.socket.close(); }
}

async function withSession(host, work) {
  const session = new McaSession(host);
  await session.connect();
  try { return await work(session); } finally { session.close(); }
}

async function probeLegacyHttp(host) {
  const url = `http://${validateLocalHost(host)}/common/basic_info`;
  try {
    const response = await fetchWithTimeout(url, { headers: { accept: "text/plain" } }, 2_500);
    if (!response.ok) return null;
    const values = Object.fromEntries((await response.text()).split(",").map((part) => part.split("=").map(decodeURIComponent)));
    if (values.ret !== "OK") return null;
    return { protocol: "legacy-http", adapterModel: values.type || values.adp_kind || "Daikin local HTTP", name: values.name, firmware: values.ver };
  } catch { return null; }
}

export function classifyCloudGatewayHttp(rootStatus, rootBody, basicStatus, basicBody) {
  const rootIsEmbeddedServer = rootStatus === 404 && /File\s+\/\s+not_found/i.test(String(rootBody));
  const basicIsMissing = basicStatus === 404 && /(?:not_found|not found)/i.test(String(basicBody));
  if (!rootIsEmbeddedServer || !basicIsMissing) return null;
  return {
    protocol: "daikin-cloud-gateway-http",
    adapterModel: "BRP069A71-compatible gateway",
    localControl: false,
    note: "The gateway is reachable on the LAN, but it does not expose a local heat-pump status or control API.",
  };
}

export function summarizeA71Response(path, status, contentType, body) {
  const text = String(body || "");
  const escapedPath = String(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizedText = text
    .replace(new RegExp(`(File\\s+)${escapedPath}(\\s+(?:not_found|not found))`, "gi"), "$1<request-path>$2")
    .replace(new RegExp(`((?:Cannot|Can not)\\s+(?:GET|HEAD|OPTIONS)\\s+)${escapedPath}(?=\\s|$)`, "gi"), "$1<request-path>");
  const keys = new Set();
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.keys(parsed).forEach((key) => keys.add(key.slice(0, 64)));
  } catch { /* not JSON */ }
  for (const match of text.matchAll(/(?:^|[,;\n\r])\s*([a-z][a-z0-9_.-]{0,63})\s*=/gi)) keys.add(match[1]);
  const routes = new Set();
  for (const match of text.matchAll(/(?:href|src|action)\s*=\s*["']([^"'#?\s]+)["']/gi)) {
    try {
      const route = new URL(match[1], "http://adapter.local").pathname
        .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<redacted>")
        .replace(/\/[a-z0-9_-]{16,}(?=\/|$)/gi, "/<redacted>");
      if (route.startsWith("/") && !route.includes("..")) routes.add(route.slice(0, 120));
    } catch { /* ignore malformed markup */ }
  }
  const lower = normalizedText.toLowerCase();
  const details = {};
  const keepScalar = (outputKey, inputKey) => {
    const value = parsed?.[inputKey];
    if (["string", "number", "boolean"].includes(typeof value) && String(value).length <= 64) details[outputKey] = value;
  };
  if (path === "/config/adapter/info") {
    keepScalar("status", "status");
    keepScalar("udpDiscovery", "udpDiscovery");
    keepScalar("wifiAuthenticationType", "wifiAuthenticationType");
    details.cloudIdentityPresent = typeof parsed?.gatewayDeviceId === "string" && parsed.gatewayDeviceId.length > 0;
  } else if (path === "/config/adapter/product_info") {
    keepScalar("model", "model_name");
    keepScalar("region", "region");
    keepScalar("deviceType", "device_type");
  } else if (path === "/config/firmware/info") {
    keepScalar("version", "version");
  } else if (path === "/config/wlan/info") {
    keepScalar("status", "status");
  }
  return {
    path,
    status,
    contentType: String(contentType || "").split(";")[0] || null,
    bytes: Buffer.byteLength(text),
    fingerprint: crypto.createHash("sha256").update(normalizedText).digest("hex").slice(0, 12),
    keys: [...keys].slice(0, 24),
    routes: [...routes].slice(0, 16),
    markers: A71_MARKERS.filter((marker) => lower.includes(marker)),
    details,
  };
}

async function readLimited(response, maximum = 64 * 1024) {
  if (!response.body?.getReader) return (await response.text()).slice(0, maximum);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (length < maximum) {
    const { done, value } = await reader.read();
    if (done) break;
    const kept = value.subarray(0, maximum - length);
    chunks.push(kept);
    length += kept.length;
    if (kept.length < value.length) break;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function inspectHttpPath(base, path) {
  try {
    const response = await fetchWithTimeout(`${base}${path}`, {
      method: "GET",
      headers: { accept: "application/json, text/plain, text/html, */*" },
    }, 1_800);
    return summarizeA71Response(path, response.status, response.headers.get("content-type"), await readLimited(response));
  } catch (error) {
    return { path, error: error.name === "AbortError" ? "timeout" : "unavailable" };
  }
}

export async function inspectA71Setup(input) {
  const host = validateLocalHost(input || "192.168.10.1");
  const base = `http://${host}`;
  const responses = [];
  let cursor = 0;
  while (cursor < A71_READ_ONLY_PATHS.length) {
    const path = A71_READ_ONLY_PATHS[cursor++];
    responses.push(await inspectHttpPath(base, path));
  }
  responses.sort((a, b) => A71_READ_ONLY_PATHS.indexOf(a.path) - A71_READ_ONLY_PATHS.indexOf(b.path));
  const reachable = responses.some((item) => !item.error);
  const baseline = responses.find((item) => item.path === "/" && !item.error);
  const findings = responses.filter((item) => !item.error && (
    item.status < 400 || !baseline || item.status !== baseline.status || item.fingerprint !== baseline.fingerprint
  ));
  return {
    reachable,
    checkedAt: new Date().toISOString(),
    pathsChecked: responses.length,
    responses: responses.filter((item) => !item.error).length,
    findings,
    safety: "Read-only HTTP GETs only; no configuration or registration calls were sent.",
  };
}

async function probeCloudGatewayHttp(host) {
  const base = `http://${validateLocalHost(host)}`;
  try {
    const [root, basic] = await Promise.all([
      fetchWithTimeout(`${base}/`, { headers: { accept: "text/plain" } }, 2_500),
      fetchWithTimeout(`${base}/common/basic_info`, { headers: { accept: "text/plain" } }, 2_500),
    ]);
    return classifyCloudGatewayHttp(root.status, await root.text(), basic.status, await basic.text());
  } catch {
    return null;
  }
}

export class LocalAlthermaConnector {
  async probe(host) {
    const safeHost = validateLocalHost(host);
    try {
      return await withSession(safeHost, async (session) => {
        const adapter = await session.adapterInfo();
        const profile = await session.request("1/UnitProfile/la").catch(() => null);
        const model = await session.request(READERS.model).catch(() => null);
        return {
          ok: true,
          protocol: "altherma-mca",
          host: safeHost,
          adapterModel: adapter.mod || "BRP069A61/A62-compatible",
          adapterFirmware: adapter.fwv || adapter.svr || null,
          model,
          profile: typeof profile === "string" ? JSON.parse(profile) : profile,
        };
      });
    } catch (mcaError) {
      const legacy = await probeLegacyHttp(safeHost);
      if (legacy) return { ok: true, host: safeHost, ...legacy, note: "Legacy air-conditioner API detected; this is not the Altherma /mca API." };
      const cloudGateway = await probeCloudGatewayHttp(safeHost);
      if (cloudGateway) return { ok: true, host: safeHost, ...cloudGateway };
      throw new AppError(
        "The device is reachable only if its adapter exposes a local API. No Altherma /mca or legacy Daikin API responded.",
        502,
        "NO_LOCAL_API",
        { hint: "Check the adapter label. BRP069A61/A62 support /mca; many WLAN cartridges are cloud-only." },
      );
    }
  }

  async snapshot(host) {
    const safeHost = validateLocalHost(host);
    return withSession(safeHost, async (session) => {
      const adapter = await session.adapterInfo().catch(() => ({}));
      const state = {};
      const unsupported = [];
      for (const [key, item] of Object.entries(READERS)) {
        try { state[key] = await session.request(item); } catch { unsupported.push(key); }
      }
      return normalizeLocalSnapshot(safeHost, adapter, state, unsupported);
    });
  }

  async inspectSetup(host) {
    return inspectA71Setup(host);
  }

  async write(host, action, value) {
    const writer = WRITERS[action];
    if (!writer) throw new AppError("That local action is not supported", 400, "UNSUPPORTED_ACTION");
    const transformed = writer.transform(value);
    await withSession(host, (session) => session.request(writer.item, transformed, "/m2m:rsp"));
    return { ok: true, action, value: transformed };
  }

  async writeSchedule(host, kind, schedule) {
    if (!['space', 'tank'].includes(kind)) throw new AppError("Unknown schedule type", 400, "INVALID_SCHEDULE");
    const item = kind === "space" ? "1/Schedule/List/Heating" : "2/Schedule/List/Heating";
    const serialized = marshallSchedule(schedule, kind);
    await withSession(host, (session) => session.request(item, JSON.stringify({ data: [serialized] }), "/m2m:rsp"));
    return { ok: true };
  }
}

export function unmarshallSchedule(input, kind = "space") {
  if (typeof input !== "string") return input;
  const slots = input.split("|")[2]?.split(";") || [];
  const result = {};
  SHORT_DAYS.forEach((shortDay, index) => {
    result[DAYS[index]] = slots.slice(index * 6, index * 6 + 6).flatMap((slot) => {
      const [time, raw] = slot.split(",");
      if (!time || raw === undefined || raw === "") return [];
      const value = kind === "space" ? Number(raw) / 10 : ({ "0": "eco", "1": "comfort", "2": "off" }[raw] ?? raw);
      return [{ time: `${time.slice(0, 2)}:${time.slice(2)}`, value }];
    });
  });
  return result;
}

export function marshallSchedule(schedule, kind = "space") {
  const stateCode = { eco: 0, comfort: 1, off: 2 };
  const slots = [];
  for (const day of DAYS) {
    const entries = Array.isArray(schedule?.[day]) ? schedule[day] : [];
    if (entries.length > 6) throw new AppError(`${day} has more than 6 schedule entries`, 400, "SCHEDULE_LIMIT");
    const normalized = entries.map((entry) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(entry.time)) throw new AppError(`Invalid time on ${day}`, 400, "INVALID_SCHEDULE");
      const encoded = kind === "space" ? Math.round(finiteRange(entry.value, 5, 40) * 10) : stateCode[entry.value];
      if (encoded === undefined) throw new AppError(`Invalid tank state on ${day}`, 400, "INVALID_SCHEDULE");
      return `${entry.time.replace(":", "")},${encoded}`;
    }).sort();
    slots.push(...normalized, ...Array(6 - normalized.length).fill(","));
  }
  return `$NULL|1|${slots.join(";")}`;
}

function normalizeLocalSnapshot(host, adapter, state, unsupported) {
  const spaceScheduleRaw = state.spaceSchedule?.data?.[0] ?? state.spaceSchedule;
  const tankScheduleRaw = state.tankSchedule?.data?.[0] ?? state.tankSchedule;
  return {
    id: `local:${host}`,
    source: "local",
    host,
    name: "Altherma",
    model: state.model || "Daikin Altherma",
    adapter: adapter.mod || "BRP069A61/A62-compatible",
    online: true,
    updatedAt: new Date().toISOString(),
    controls: {
      space: {
        power: state.spacePower, active: Boolean(state.spaceActive), operationMode: state.operationMode,
        targetTemperature: state.targetTemperature, indoorTemperature: state.indoorTemperature,
        outdoorTemperature: state.outdoorTemperature, leavingWaterTemperature: state.leavingWaterTemperature,
        leavingWaterOffset: state.leavingWaterOffset, controlMode: state.controlMode,
      },
      tank: {
        power: state.tankPower, active: Boolean(state.tankActive), powerful: Boolean(state.tankPowerful),
        temperature: state.tankTemperature, targetTemperature: state.tankTargetTemperature,
      },
    },
    diagnostics: {
      spaceError: Boolean(state.spaceError), spaceWarning: Boolean(state.spaceWarning),
      tankError: Boolean(state.tankError), tankWarning: Boolean(state.tankWarning),
      indoorSoftware: state.indoorSoftware, outdoorSoftware: state.outdoorSoftware,
    },
    energy: { space: state.spaceConsumption, tank: state.tankConsumption },
    schedules: {
      space: unmarshallSchedule(spaceScheduleRaw, "space"),
      tank: unmarshallSchedule(tankScheduleRaw, "tank"),
      nextSpace: state.nextSpaceSchedule?.data ?? state.nextSpaceSchedule,
      nextTank: state.nextTankSchedule?.data ?? state.nextTankSchedule,
    },
    unsupported,
    actions: Object.keys(WRITERS),
  };
}
