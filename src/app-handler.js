import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAlthermaConnector } from "./connectors/local-altherma.js";
import { OnectaConnector } from "./connectors/onecta.js";
import { demoCloudDevice } from "./demo.js";
import { publicError, AppError } from "./lib/errors.js";
import { readJson, sendJson } from "./lib/http.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(root, "public");

export async function createRequestHandler({
  store,
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
  const local = new LocalAlthermaConnector();
  const cloud = new OnectaConnector(() => store.read(), (settings) => store.write(settings));

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
      if (body.source === "cloud") return sendJson(response, 200, await cloud.write(body));
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
      if (body.source === "cloud") return sendJson(response, 200, await cloud.writeSchedule(body));
      throw new AppError("Unknown connector source", 400, "INVALID_SOURCE");
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
