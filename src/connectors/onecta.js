import crypto from "node:crypto";
import { AppError } from "../lib/errors.js";
import { fetchWithTimeout, safeSegment } from "../lib/http.js";

const AUTHORIZE_URL = "https://idp.onecta.daikineurope.com/v1/oidc/authorize";
const TOKEN_URL = "https://idp.onecta.daikineurope.com/v1/oidc/token";
const API_URL = "https://api.onecta.daikineurope.com";
const SCOPE = "openid onecta:basic.integration offline_access";

function base64url(value) { return Buffer.from(value).toString("base64url"); }

function collectLeaves(value, prefix = "", inherited = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const metadataKeys = new Set(["value", "settable", "unit", "minValue", "maxValue", "stepValue", "values", "ref"]);
  const metadata = {
    settable: value.settable ?? inherited.settable ?? false,
    unit: value.unit ?? inherited.unit,
    min: value.minValue ?? inherited.min,
    max: value.maxValue ?? inherited.max,
    step: value.stepValue ?? inherited.step,
    values: value.values ?? inherited.values,
  };
  if (Object.hasOwn(value, "value") && (value.value === null || typeof value.value !== "object" || Array.isArray(value.value))) {
    return [{ path: prefix, value: value.value, ...metadata }];
  }
  const target = Object.hasOwn(value, "value") && value.value && typeof value.value === "object" ? value.value : value;
  return Object.entries(target).flatMap(([key, child]) => {
    if (metadataKeys.has(key)) return [];
    const path = `${prefix}/${key}`;
    if (child && typeof child === "object" && !Array.isArray(child)) return collectLeaves(child, path, metadata);
    return [{ path, value: child, ...metadata }];
  });
}

export function normalizeCloudDevices(rawDevices) {
  return (Array.isArray(rawDevices) ? rawDevices : []).map((device) => {
    const points = (device.managementPoints || []).map((point) => {
      const characteristics = Object.entries(point)
        .filter(([key, value]) => !["embeddedId", "managementPointType", "managementPointSubType", "name", "schedule"].includes(key) && value && typeof value === "object")
        .map(([name, value]) => ({
          name,
          ref: value.ref,
          settable: Boolean(value.settable),
          leaves: collectLeaves(value),
          raw: value,
        }));
      return {
        id: point.embeddedId || point.managementPointType,
        type: point.managementPointType,
        subtype: point.managementPointSubType,
        name: point.name?.value || point.name || point.managementPointType,
        schedule: point.schedule || null,
        characteristics,
      };
    });
    return {
      id: device.id,
      source: "cloud",
      name: device.managementPoints?.find((point) => point.managementPointType === "climateControl")?.name?.value || device.deviceModel || "Daikin",
      model: device.deviceModel,
      firmware: device.firmwareVersion,
      online: device.isCloudConnectionUp?.value !== false,
      updatedAt: new Date().toISOString(),
      points,
      raw: device,
    };
  });
}

function findWritable(rawDevices, deviceId, pointId, characteristic, path) {
  const device = rawDevices.find((item) => item.id === deviceId);
  const point = device?.managementPoints?.find((item) => (item.embeddedId || item.managementPointType) === pointId);
  const node = point?.[characteristic];
  if (!node) return null;
  if (!path) return node.settable ? node : null;
  const leaf = collectLeaves(node).find((item) => item.path === path);
  return leaf?.settable ? leaf : null;
}

export function validateWritableValue(target, value) {
  const current = target?.value;
  const values = target?.values;
  const min = target?.min ?? target?.minValue;
  const max = target?.max ?? target?.maxValue;
  if (Array.isArray(values) && !values.some((allowed) => Object.is(allowed, value))) {
    throw new AppError("Value is not one of the options advertised by your unit", 400, "INVALID_VALUE");
  }
  if (typeof current === "boolean" && typeof value !== "boolean") {
    throw new AppError("This control requires an on/off value", 400, "INVALID_VALUE");
  }
  if (typeof current === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new AppError("This control requires a number", 400, "INVALID_VALUE");
    if (Number.isFinite(min) && value < min) throw new AppError(`Value must be at least ${min}`, 400, "INVALID_VALUE");
    if (Number.isFinite(max) && value > max) throw new AppError(`Value must be at most ${max}`, 400, "INVALID_VALUE");
  }
  if (typeof current === "string" && typeof value !== "string") {
    throw new AppError("This control requires text", 400, "INVALID_VALUE");
  }
  return value;
}

export class OnectaConnector {
  constructor(loadSettings, saveSettings) {
    this.loadSettings = loadSettings;
    this.saveSettings = saveSettings;
    this.cache = null;
    this.rateLimit = {};
  }

  async status(redirectUri) {
    const settings = await this.loadSettings();
    return {
      configured: Boolean(settings.onecta?.clientId && settings.onecta?.clientSecret),
      connected: Boolean(settings.onecta?.tokens?.refresh_token || settings.onecta?.tokens?.access_token),
      redirectUri,
      rateLimit: this.rateLimit,
    };
  }

  async authorizationUrl(redirectUri) {
    const settings = await this.loadSettings();
    const clientId = settings.onecta?.clientId;
    if (!clientId || !settings.onecta?.clientSecret) throw new AppError("Save your Daikin developer client ID and secret first", 400, "CLOUD_NOT_CONFIGURED");
    const state = crypto.randomBytes(24).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    settings.onecta.oauthPending ||= {};
    const now = Date.now();
    settings.onecta.oauthPending = Object.fromEntries(Object.entries(settings.onecta.oauthPending)
      .filter(([, pending]) => pending?.expiresAt > now)
      .slice(-63));
    settings.onecta.oauthPending[state] = { verifier, redirectUri, expiresAt: now + 10 * 60_000 };
    await this.saveSettings(settings);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirectUri,
      scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchange(code, state) {
    const settings = await this.loadSettings();
    const pending = settings.onecta?.oauthPending?.[state];
    if (!pending || pending.expiresAt < Date.now()) throw new AppError("OAuth state expired; start the connection again", 400, "OAUTH_STATE_INVALID");
    delete settings.onecta.oauthPending[state];
    const tokens = await this.tokenRequest(settings.onecta, {
      grant_type: "authorization_code", code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier,
    });
    settings.onecta.tokens = withExpiry(tokens);
    await this.saveSettings(settings);
    return true;
  }

  async disconnect() {
    const settings = await this.loadSettings();
    if (settings.onecta) {
      delete settings.onecta.tokens;
      delete settings.onecta.deviceCache;
      delete settings.onecta.oauthPending;
    }
    await this.saveSettings(settings);
    this.cache = null;
  }

  async tokenRequest(onecta, fields) {
    const response = await fetchWithTimeout(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        ...fields,
        client_id: onecta.clientId,
        client_secret: onecta.clientSecret,
      }),
    }, 30_000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new AppError(payload.error_description || payload.error || "Daikin OAuth request failed", 502, "OAUTH_FAILED");
    return payload;
  }

  async accessToken() {
    const settings = await this.loadSettings();
    const onecta = settings.onecta || {};
    let tokens = onecta.tokens;
    if (!tokens) throw new AppError("Connect your ONECTA account first", 401, "CLOUD_NOT_CONNECTED");
    if (tokens.expires_at && tokens.expires_at > Date.now() + 60_000) return tokens.access_token;
    if (!tokens.refresh_token) throw new AppError("The Daikin session expired; reconnect it", 401, "CLOUD_SESSION_EXPIRED");
    const refreshed = await this.tokenRequest(onecta, { grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    tokens = withExpiry({ ...tokens, ...refreshed, refresh_token: refreshed.refresh_token || tokens.refresh_token });
    settings.onecta.tokens = tokens;
    await this.saveSettings(settings);
    return tokens.access_token;
  }

  captureRateLimit(headers) {
    const get = (...names) => names.map((name) => headers.get(name)).find((value) => value !== null);
    this.rateLimit = {
      limitMinute: numberOrNull(get("x-ratelimit-limit-minute", "ratelimit-limit")),
      remainingMinute: numberOrNull(get("x-ratelimit-remaining-minute")),
      limitDay: numberOrNull(get("x-ratelimit-limit-day")),
      remainingDay: numberOrNull(get("x-ratelimit-remaining-day")),
      retryAfter: numberOrNull(get("retry-after")),
    };
  }

  async api(path, options = {}, retry = true) {
    const token = await this.accessToken();
    const response = await fetchWithTimeout(`${API_URL}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
    }, 60_000);
    this.captureRateLimit(response.headers);
    if (response.status === 401 && retry) {
      const settings = await this.loadSettings();
      if (settings.onecta?.tokens) settings.onecta.tokens.expires_at = 0;
      await this.saveSettings(settings);
      return this.api(path, options, false);
    }
    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (!response.ok) {
      const status = response.status === 429 ? 429 : 502;
      throw new AppError(payload?.message || `Daikin API returned ${response.status}`, status, payload?.code || "CLOUD_API_ERROR", { rateLimit: this.rateLimit });
    }
    return payload;
  }

  async devices(force = false) {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;
    const cachedSettings = await this.loadSettings();
    if (!force && cachedSettings.onecta?.deviceCache?.expiresAt > Date.now()) {
      this.cache = cachedSettings.onecta.deviceCache;
      return this.cache.value;
    }
    const value = await this.api("/v1/gateway-devices");
    this.cache = { value, expiresAt: Date.now() + 8 * 60_000 };
    const settings = await this.loadSettings();
    settings.onecta ||= {};
    settings.onecta.deviceCache = this.cache;
    await this.saveSettings(settings);
    return value;
  }

  async snapshot(force = false) { return normalizeCloudDevices(await this.devices(force)); }

  async write({ deviceId, pointId, characteristic, path = "", value }) {
    if (!Number.isFinite(value) && typeof value === "number") throw new AppError("Value must be finite", 400, "INVALID_VALUE");
    const raw = await this.devices(false);
    const target = findWritable(raw, deviceId, pointId, characteristic, path);
    if (!target) {
      throw new AppError("This characteristic is not advertised as writable by your unit", 400, "READ_ONLY_CHARACTERISTIC");
    }
    validateWritableValue(target, value);
    const url = `/v1/gateway-devices/${safeSegment(deviceId)}/management-points/${safeSegment(pointId)}/characteristics/${safeSegment(characteristic)}`;
    const body = path ? { value, path } : { value };
    await this.api(url, { method: "PATCH", body: JSON.stringify(body) });
    await this.clearDeviceCache();
    return { ok: true };
  }

  async writeSchedule({ deviceId, pointId, mode = "any", section, value }) {
    if (!['current', 'schedules'].includes(section)) throw new AppError("Invalid schedule section", 400, "INVALID_SCHEDULE");
    const raw = await this.devices(false);
    const device = raw.find((item) => item.id === deviceId);
    const point = device?.managementPoints?.find((item) => (item.embeddedId || item.managementPointType) === pointId);
    if (!point?.schedule?.settable) throw new AppError("This management point does not advertise writable schedules", 400, "SCHEDULE_UNAVAILABLE");
    const url = `/v1/gateway-devices/${safeSegment(deviceId)}/management-points/${safeSegment(pointId)}/schedule/${safeSegment(mode)}/${section}`;
    await this.api(url, { method: "PUT", body: JSON.stringify(value) });
    await this.clearDeviceCache();
    return { ok: true };
  }

  async clearDeviceCache() {
    this.cache = null;
    const settings = await this.loadSettings();
    if (settings.onecta) delete settings.onecta.deviceCache;
    await this.saveSettings(settings);
  }
}

function safeJson(text) { try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; } }
function withExpiry(tokens) { return { ...tokens, expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000 }; }
function numberOrNull(value) { const number = Number(value); return value === undefined || value === null || !Number.isFinite(number) ? null : number; }
