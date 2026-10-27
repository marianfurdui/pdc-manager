import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAlthermaConnector } from "./connectors/local-altherma.js";
import { normalizeCloudDevices, OnectaConnector } from "./connectors/onecta.js";
import { demoCloudDevice, demoJournal } from "./demo.js";
import { ensureWeather } from "./lib/degree-days.js";
import { evaluate, INSTALLER_CHECKLIST } from "./lib/efficiency.js";
import { publicError, AppError } from "./lib/errors.js";
import { readJson, sendJson } from "./lib/http.js";
import { normalizeJournal, recordChange, recordSnapshot } from "./lib/journal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(root, "public");

const HOUSE_CHOICES = {
  emitters: ["underfloor", "radiators", "mixed", "fancoil"],
  tariff: ["flat", "dual", "dynamic"],
  solar: ["none", "pv", "pvBattery"],
  insulation: ["poor", "average", "renovated", "new"],
  roomThermostats: ["none", "some", "all"],
  belowFloor: ["ground", "basement", "heated"],
  ventilation: ["windows", "extract", "recovery"],
};
const HOUSE_RANGES = {
  area: [10, 2000],
  occupants: [1, 20],
  dayTemp: [15, 25],
  nightTemp: [12, 25],
  showersPerDay: [0, 30],
  slabInsulation: [0, 50],
  floors: [1, 5],
  elevation: [-100, 3000],
  basementArea: [0, 1000],
  latitude: [-90, 90],
  longitude: [-180, 180],
};

// Only known fields with sane values are stored; anything else is dropped.
export function sanitizeHouse(input = {}) {
  const house = {};
  for (const [key, [min, max]] of Object.entries(HOUSE_RANGES)) {
    if (input[key] === "" || input[key] === null || input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new AppError(`${key} must be between ${min} and ${max}`, 400, "INVALID_HOUSE");
    // Coordinates keep up to 8 decimals; ensureWeather rounds them to 0.1°
    // before anything is sent to Open-Meteo.
    house[key] = key === "latitude" || key === "longitude" ? Math.round(value * 1e8) / 1e8 : Math.round(value * 10) / 10;
  }
  for (const [key, choices] of Object.entries(HOUSE_CHOICES)) {
    if (!input[key]) continue;
    if (!choices.includes(input[key])) throw new AppError(`Unknown ${key}`, 400, "INVALID_HOUSE");
    house[key] = input[key];
  }
  if (input.rooms !== undefined) {
    if (!Array.isArray(input.rooms) || input.rooms.length > 30) throw new AppError("Up to 30 rooms can be saved", 400, "INVALID_HOUSE");
    house.rooms = input.rooms
      .map((room) => ({ name: String(room?.name ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40), area: room?.area, target: room?.target }))
      .filter((room) => room.name || (room.area !== "" && room.area !== undefined && room.area !== null))
      .map((room, index) => {
        const area = Number(room.area);
        const target = Number(room.target);
        if (!Number.isFinite(area) || area < 1 || area > 300) throw new AppError(`Room ${index + 1}: area must be between 1 and 300 m²`, 400, "INVALID_HOUSE");
        if (!Number.isFinite(target) || target < 5 || target > 28) throw new AppError(`Room ${index + 1}: temperature must be between 5 and 28 °C`, 400, "INVALID_HOUSE");
        return { name: room.name || `Room ${index + 1}`, area: Math.round(area * 10) / 10, target: Math.round(target * 2) / 2 };
      });
    if (!house.rooms.length) delete house.rooms;
  }
  if (input.timeZone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: String(input.timeZone) });
      house.timeZone = String(input.timeZone);
    } catch {
      throw new AppError("Unknown time zone", 400, "INVALID_HOUSE");
    }
  }
  return house;
}

export async function createRequestHandler({
  store,
  journalStore = null,
  host = "127.0.0.1",
  port = 8787,
  demoMode = false,
  appPassword = "",
  publicUrl = "",
  localEnabled = true,
  runtime = "local",
} = {}) {
  if (!store) throw new TypeError("A settings store is required");
  await store.init();
  if (journalStore) await journalStore.init();
  const local = new LocalAlthermaConnector();

  async function updateJournal(change) {
    if (!journalStore) return null;
    const journal = normalizeJournal(await journalStore.read());
    if ((await change(journal)) !== false) await journalStore.write(journal);
    return journal;
  }

  const cloud = new OnectaConnector(() => store.read(), (settings) => store.write(settings), {
    onFreshDevices: async (raw) => {
      const timeZone = (await store.read()).house?.timeZone;
      await updateJournal((journal) => recordSnapshot(journal, normalizeCloudDevices(raw), { timeZone }));
    },
  });

  function isAuthorized(request) {
    // OAuth callbacks must remain reachable after the identity provider
    // redirects back. A random, single-use state is validated before tokens
    // are accepted.
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/oauth/callback") return true;
    if (!appPassword) return true;
    const value = request.headers.authorization || "";
    if (!value.startsWith("Basic ")) return false;
    let password = "";
    try {
      password = Buffer.from(value.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
    } catch {
      return false;
    }
    const expected = Buffer.from(appPassword);
    const actual = Buffer.from(password);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  function publicBaseUrl(request) {
    if (publicUrl) return publicUrl.replace(/\/$/, "");
    const requestHost = request.headers.host || `localhost:${port}`;
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(requestHost)) {
      throw new AppError("Set PUBLIC_URL before using cloud OAuth through a proxy", 400, "PUBLIC_URL_REQUIRED");
    }
    return `http://${requestHost}`;
  }

  async function settingsSummary(request) {
    const settings = await store.read();
    const redirectUri = `${publicBaseUrl(request)}/oauth/callback`;
    return {
      local: localEnabled ? {
        host: settings.local?.host || "",
        protocol: settings.local?.protocol || "",
        adapterModel: settings.local?.adapterModel || "",
        localControl: settings.local?.localControl,
        note: settings.local?.note || "",
        checkedAt: settings.local?.checkedAt || "",
      } : {},
      house: settings.house || {},
      setAside: settings.efficiency?.setAside || [],
      onecta: {
        clientId: settings.onecta?.clientId || "",
        hasClientSecret: Boolean(settings.onecta?.clientSecret),
        ...(await cloud.status(redirectUri)),
      },
      server: {
        bind: host,
        runtime,
        passwordProtected: Boolean(appPassword),
        demoMode,
        localReachability: localEnabled,
      },
    };
  }

  async function api(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/settings") {
      return sendJson(response, 200, await settingsSummary(request));
    }
    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readJson(request);
      const settings = await store.read();
      if (localEnabled && body.localHost !== undefined) {
        settings.local = { ...settings.local, host: String(body.localHost || "").trim() };
      }
      settings.onecta ||= {};
      if (body.clientId !== undefined) settings.onecta.clientId = String(body.clientId).trim();
      if (body.clientSecret) settings.onecta.clientSecret = String(body.clientSecret);
      if (body.house !== undefined) settings.house = sanitizeHouse(body.house);
      if (body.setAside !== undefined) {
        // Suggestions the owner can't act on for now, by finding id.
        if (!Array.isArray(body.setAside) || body.setAside.length > 50 || !body.setAside.every((id) => typeof id === "string" && /^[a-z0-9-]{1,60}$/.test(id))) {
          throw new AppError("Invalid list of set-aside suggestions", 400, "INVALID_SET_ASIDE");
        }
        settings.efficiency = { ...settings.efficiency, setAside: [...new Set(body.setAside)] };
      }
      await store.write(settings);
      return sendJson(response, 200, await settingsSummary(request));
    }
    if (request.method === "POST" && url.pathname === "/api/local/probe") {
      if (!localEnabled) throw new AppError("Gateway checks require the dashboard running on your home network", 409, "LOCAL_NETWORK_REQUIRED");
      const body = await readJson(request);
      const result = await local.probe(body.host);
      const settings = await store.read();
      settings.local = {
        host: result.host,
        protocol: result.protocol,
        adapterModel: result.adapterModel || "",
        localControl: result.localControl !== false,
        note: result.note || "",
        checkedAt: new Date().toISOString(),
      };
      await store.write(settings);
      return sendJson(response, 200, result);
    }
    if (request.method === "GET" && url.pathname === "/api/cloud/connect") {
      const redirectUri = `${publicBaseUrl(request)}/oauth/callback`;
      response.writeHead(302, { location: await cloud.authorizationUrl(redirectUri), "cache-control": "no-store" });
      return response.end();
    }
    if (request.method === "POST" && url.pathname === "/api/cloud/disconnect") {
      await readJson(request);
      await cloud.disconnect();
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/devices") {
      if (demoMode) return sendJson(response, 200, {
        devices: [demoCloudDevice],
        errors: [],
        rateLimit: { limitMinute: 20, remainingMinute: 18, limitDay: 200, remainingDay: 184 },
        demo: true,
      });
      const settings = await store.read();
      const devices = [];
      const errors = [];
      if (localEnabled && settings.local?.host && settings.local?.localControl !== false) {
        try {
          devices.push(await local.snapshot(settings.local.host));
        } catch (error) {
          errors.push({ source: "local", message: error.message, code: error.code });
        }
      }
      if (settings.onecta?.tokens) {
        try {
          devices.push(...await cloud.snapshot(url.searchParams.get("refresh") === "true"));
        } catch (error) {
          errors.push({ source: "cloud", message: error.message, code: error.code });
        }
      }
      return sendJson(response, 200, { devices, errors, rateLimit: cloud.rateLimit });
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      const body = await readJson(request);
      if (demoMode) return sendJson(response, 200, { ok: true, demo: true });
      if (body.source === "local") {
        if (!localEnabled) throw new AppError("Local control requires the dashboard running on your home network", 409, "LOCAL_NETWORK_REQUIRED");
        const settings = await store.read();
        return sendJson(response, 200, await local.write(settings.local?.host, body.action, body.value));
      }
      if (body.source === "cloud") {
        const result = await cloud.write(body);
        await updateJournal((journal) => recordChange(journal, {
          point: body.pointId, setting: `${body.characteristic}${body.path || ""}`, from: result.previous, to: body.value,
        })).catch(() => {});
        return sendJson(response, 200, { ok: true });
      }
      throw new AppError("Unknown connector source", 400, "INVALID_SOURCE");
    }
    if (request.method === "PUT" && url.pathname === "/api/schedule") {
      const body = await readJson(request, 256 * 1024);
      if (demoMode) return sendJson(response, 200, { ok: true, demo: true });
      if (body.source === "local") {
        if (!localEnabled) throw new AppError("Local schedules require the dashboard running on your home network", 409, "LOCAL_NETWORK_REQUIRED");
        const settings = await store.read();
        return sendJson(response, 200, await local.writeSchedule(settings.local?.host, body.kind, body.schedule));
      }
      if (body.source === "cloud") {
        const result = await cloud.writeSchedule(body);
        await updateJournal((journal) => recordChange(journal, {
          point: body.pointId, setting: `schedule/${body.mode || "any"}/${body.section}`, to: body.section === "current" ? body.value : "programme edited",
        })).catch(() => {});
        return sendJson(response, 200, result);
      }
      throw new AppError("Unknown connector source", 400, "INVALID_SOURCE");
    }
    if (request.method === "GET" && url.pathname === "/api/efficiency") {
      const settings = await store.read();
      const house = settings.house || {};
      let devices = [];
      let journal = normalizeJournal(null);
      let weatherError = "";
      if (demoMode) {
        devices = [demoCloudDevice];
        journal = demoJournal();
      } else {
        // Built only from data already fetched: no ONECTA request is made.
        if (settings.onecta?.tokens) devices = (await cloud.cachedSnapshot()) || [];
        if (journalStore) {
          journal = normalizeJournal(await journalStore.read());
          if (Number.isFinite(house.latitude) && Number.isFinite(house.longitude)) {
            try {
              if (await ensureWeather(journal, house)) await journalStore.write(journal);
            } catch (error) {
              weatherError = error instanceof AppError ? error.message : "Weather history is unavailable right now";
            }
          }
        }
      }
      const result = evaluate({ devices, house, journal });
      const setAside = new Set(settings.efficiency?.setAside || []);
      return sendJson(response, 200, {
        ...result,
        findings: result.findings.map((item) => (setAside.has(item.id) ? { ...item, setAside: true } : item)),
        stats: result.stats.slice(-24),
        changes: journal.changes.slice(-20),
        samples: journal.samples.length,
        weather: { available: Boolean(journal.weather && Object.keys(journal.weather.daily || {}).length), error: weatherError },
        profileComplete: ["latitude", "longitude", "area", "occupants", "dayTemp"].every((key) => Number.isFinite(house[key])),
        installerChecklist: INSTALLER_CHECKLIST,
      });
    }
    throw new AppError("API route not found", 404, "NOT_FOUND");
  }

  async function serveStatic(response, pathname) {
    const clean = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!/^[a-zA-Z0-9._/-]+$/.test(clean) || clean.includes("..")) throw new AppError("Not found", 404, "NOT_FOUND");
    const file = path.join(publicDirectory, clean);
    let content;
    try {
      content = await fs.readFile(file);
    } catch (error) {
      if (error.code === "ENOENT") throw new AppError("Not found", 404, "NOT_FOUND");
      throw error;
    }
    const extension = path.extname(file);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json",
      ".webmanifest": "application/manifest+json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    }[extension] || "application/octet-stream";
    response.writeHead(200, {
      "content-type": type,
      "content-length": content.length,
      "cache-control": extension === ".html" ? "no-cache" : "public, max-age=300",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://idp.onecta.daikineurope.com",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    response.end(content);
  }

  return async function requestHandler(request, response) {
    try {
      if (!isAuthorized(request)) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="Altherma Control", charset="UTF-8"' });
        return response.end("Authentication required");
      }
      const url = new URL(request.url || "/", "http://localhost");
      if (url.pathname === "/oauth/callback") {
        if (url.searchParams.get("error")) {
          throw new AppError(url.searchParams.get("error_description") || "Daikin authorization was declined", 400, "OAUTH_DECLINED");
        }
        await cloud.exchange(url.searchParams.get("code"), url.searchParams.get("state"));
        response.writeHead(302, { location: "/?connected=1", "cache-control": "no-store" });
        return response.end();
      }
      if (url.pathname.startsWith("/api/")) return await api(request, response, url);
      return await serveStatic(response, url.pathname);
    } catch (error) {
      const result = publicError(error);
      const pathname = new URL(request.url || "/", "http://localhost").pathname;
      if (pathname.startsWith("/api/")) return sendJson(response, result.status, result.body);
      const safe = String(result.body.message).replace(/[<>&"']/g, "");
      response.writeHead(result.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(safe);
    }
  };
}
