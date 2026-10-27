const app = document.querySelector("#app");
const pill = document.querySelector("#connection-pill");
const refreshButton = document.querySelector("#refresh-button");
const toastRegion = document.querySelector("#toast-region");

const state = {
  settings: null,
  devices: [],
  errors: [],
  rateLimit: {},
  loading: true,
  loadedAt: 0,
  selectedId: null,
  pending: false,
  scheduleDraft: null,
  gatewayCheck: null,
  writes: new Map(),
  energyPeriod: "w",
  efficiency: null,
};
const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const dayLabels = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };
const weekdays = days.slice(0, 5);
// Stepper presses are collected into one write so a few taps cost a single
// ONECTA request against the 20/minute and 200/day quota.
const WRITE_DELAY = 1200;
const STALE_AFTER = 5 * 60 * 1000;

const escapeHtml = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const titleCase = (value) => String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_/]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const sentenceCase = (value) => { const text = titleCase(value).toLowerCase(); return text.charAt(0).toUpperCase() + text.slice(1); };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const activeDevice = () => state.devices.find((device) => device.id === state.selectedId) || state.devices[0];
const unbox = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "value")) return value;
  const wrapperKeys = new Set(["value", "settable", "values", "unit", "minValue", "maxValue", "stepValue", "ref"]);
  return Object.keys(value).every((key) => wrapperKeys.has(key)) ? value.value : value;
};

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `Request failed (${response.status})`);
  return payload;
}

function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error" : ""}`;
  node.setAttribute("role", error ? "alert" : "status");
  node.textContent = message;
  toastRegion.append(node);
  setTimeout(() => node.remove(), error ? 6500 : 4200);
}

async function load(force = false) {
  refreshButton.classList.add("busy");
  try {
    const [settings, result] = await Promise.all([
      request("/api/settings"),
      request(`/api/devices${force ? "?refresh=true" : ""}`),
    ]);
    state.settings = settings;
    state.devices = result.devices || [];
    state.errors = result.errors || [];
    state.rateLimit = result.rateLimit || settings.onecta?.rateLimit || {};
    state.loadedAt = Date.now();
    if (!state.devices.some((device) => device.id === state.selectedId)) state.selectedId = state.devices[0]?.id || null;
    state.loading = false;
    updateConnectionPill();
    render();
    loadEfficiency();
  } catch (error) {
    state.loading = false;
    app.innerHTML = `<section class="empty-state"><h1>Can't reach the controller</h1><p>${escapeHtml(error.message)}</p><button class="primary" data-command="reload">Try again</button></section>`;
  } finally {
    refreshButton.classList.remove("busy");
  }
}

// Suggestions are built on the server from data it already has, so this
// never spends ONECTA quota. A failure just leaves the panel out.
async function loadEfficiency() {
  try {
    state.efficiency = await request("/api/efficiency");
    if (!state.writes.size && !state.scheduleDraft) render();
  } catch {
    state.efficiency = null;
  }
}

function updateConnectionPill() {
  const online = state.devices.some((device) => device.online);
  const connected = Boolean(state.settings?.onecta?.connected);
  pill.className = `connection-pill${online ? " online" : connected ? " ready" : ""}`;
  pill.innerHTML = `<i></i>${online ? "Heat pump online" : connected ? "Waiting for heat pump" : "Not connected"}`;
}

function currentRoute() {
  const value = location.hash.slice(1) || "overview";
  return ["overview", "controls", "schedule", "system"].includes(value) ? value : "overview";
}

function notices() {
  return state.errors.map((error) => `<div class="notice error"><strong>${escapeHtml(error.source === "cloud" ? "Daikin cloud" : "Home network")} didn't respond.</strong> ${escapeHtml(error.message)}</div>`).join("");
}

function devicePicker(device) {
  if (state.devices.length < 2) return "";
  return `<label class="device-picker"><span>Heat pump</span><select data-device-picker>${state.devices.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === device.id ? "selected" : ""}>${escapeHtml(item.name || item.model || "Daikin")}</option>`).join("")}</select></label>`;
}

function pageHead(title, subtitle, device) {
  return `<header class="page-head"><div><h1>${escapeHtml(title)}</h1>${subtitle ? `<p class="subhead">${escapeHtml(subtitle)}</p>` : ""}</div>${device ? devicePicker(device) : ""}</header>`;
}

/* ---------- Values, labels and colour ---------- */

function formatNumber(value, step) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "—");
  const decimals = step ? (String(step).split(".")[1]?.length || 0) : Number.isInteger(number) ? 0 : 1;
  return number.toFixed(decimals);
}

function withUnit(text, unit) {
  if (!unit) return text;
  return unit === "°C" ? `${text}°` : `${text} ${unit}`;
}

function displayValue(leaf, value = leaf.value) {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    const signed = /offset/i.test(leaf.path || "") && value > 0 ? "+" : "";
    return withUnit(`${signed}${formatNumber(value, leaf.step)}`, leaf.unit);
  }
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return "Available";
  return sentenceCase(value);
}

// Temperature is the one thing colour means in this interface: blue for cool,
// green-teal for mild, amber to red for warm and hot.
const THERMAL = [[0, [61, 120, 181]], [0.36, [94, 158, 142]], [0.7, [224, 145, 47]], [1, [204, 79, 44]]];
const SCALES = { room: [15, 25], water: [25, 60], offset: [-6, 6] };

function thermal(value, kind) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "#9aa7ad";
  const [low, high] = SCALES[kind || (number > 30 ? "water" : "room")];
  const t = clamp((number - low) / (high - low), 0, 1);
  const index = THERMAL.findIndex(([stop]) => stop >= t);
  const [stopB, colorB] = THERMAL[Math.max(index, 1)];
  const [stopA, colorA] = THERMAL[Math.max(index, 1) - 1];
  const mix = (t - stopA) / (stopB - stopA || 1);
  return `rgb(${colorA.map((channel, i) => Math.round(channel + (colorB[i] - channel) * mix)).join(",")})`;
}

function scaleFor(entry) {
  if (/offset/.test(entry.key)) return "offset";
  if (/domestichotwater|tank|leavingwater/.test(entry.key)) return "water";
  return "room";
}

function pointTitle(point) {
  const type = String(point.type || point.name || "");
  if (/domesticHotWater/i.test(type)) return "Hot water";
  if (/climateControl/i.test(type)) return point.name && point.name !== point.type ? point.name : "Heating";
  if (/indoorUnit/i.test(type)) return "Indoor unit";
  if (/outdoorUnit/i.test(type)) return "Outdoor unit";
  if (/gateway/i.test(type)) return "Wi-Fi adapter";
  return point.name || titleCase(type);
}

const LEAF_NAMES = {
  onOffMode: "Power",
  operationMode: "Mode",
  powerfulMode: "Boost",
  roomTemperature: "Room",
  outdoorTemperature: "Outside",
  leavingWaterTemperature: "Leaving water",
  tankTemperature: "Tank",
  domesticHotWaterTemperature: "Tank",
  leavingWaterOffset: "Water offset",
};
const SETPOINT_NAMES = {
  roomTemperature: "Room target",
  domesticHotWaterTemperature: "Tank target",
  leavingWaterTemperature: "Water target",
  leavingWaterOffset: "Water offset",
};

function readableLeaf(characteristic, leaf) {
  const segments = String(leaf.path || "").split("/").filter(Boolean);
  const last = segments.at(-1) || characteristic.name;
  const isSetpoint = segments.includes("setpoints") || (leaf.settable && typeof leaf.value === "number");
  const base = (isSetpoint && SETPOINT_NAMES[last]) || LEAF_NAMES[last] || titleCase(last);
  const modeIndex = segments.indexOf("operationModes");
  const mode = modeIndex >= 0 ? segments[modeIndex + 1] : "";
  return mode ? `${modeLabel(mode)} ${base.toLowerCase()}` : base;
}

function modeLabel(value) {
  const names = { heating: "Heat", cooling: "Cool", auto: "Auto", fanOnly: "Fan", dry: "Dry", on: "On", off: "Off" };
  return names[value] || sentenceCase(value);
}

/* ---------- Device model ---------- */

function pointEntries(point) {
  return (point.characteristics || []).flatMap((characteristic) =>
    (characteristic.leaves || []).map((leaf) => ({ point, characteristic, leaf, key: `${point.type || ""} ${characteristic.name || ""} ${leaf.path || ""}`.toLowerCase() })));
}

function flattenDevice(device) {
  return (device.points || []).flatMap(pointEntries);
}

const keyOf = (device, entry) => [device.id, entry.point.id, entry.characteristic.name, entry.leaf.path || ""].join("|");
const shownValue = (device, entry) => { const write = state.writes.get(keyOf(device, entry)); return write ? write.value : entry.leaf.value; };
const isOnOff = (leaf) => typeof leaf.value === "boolean" || (Array.isArray(leaf.values) && leaf.values.length === 2 && leaf.values.includes("on") && leaf.values.includes("off"));
const isOn = (value) => value === true || value === "on";
const flipped = (leaf, value) => (typeof leaf.value === "boolean" ? !isOn(value) : isOn(value) ? "off" : "on");

function entryByKey(key) {
  for (const device of state.devices) {
    const entry = flattenDevice(device).find((item) => keyOf(device, item) === key);
    if (entry) return { device, entry };
  }
  return null;
}

function pickSetpoint(entries, mode) {
  const candidates = entries.filter((entry) => entry.leaf.settable && typeof entry.leaf.value === "number");
  const forMode = candidates.filter((entry) => !/\/operationmodes\//.test(entry.key) || (mode && entry.key.includes(`/operationmodes/${mode.toLowerCase()}/`)));
  const pool = forMode.length ? forMode : candidates;
  for (const name of ["roomtemperature", "domestichotwatertemperature", "leavingwatertemperature", "leavingwateroffset"]) {
    const found = pool.find((entry) => entry.key.endsWith(name));
    if (found) return found;
  }
  return pool[0] || null;
}

function zoneModel(device, point) {
  const entries = pointEntries(point);
  const named = (name) => entries.find((entry) => entry.characteristic.name === name && !entry.leaf.path);
  const mode = named("operationMode");
  const isTank = /domestichotwater/i.test(point.type || "");
  const readingFor = (patterns) => {
    for (const pattern of patterns) {
      const found = entries.find((entry) => !entry.leaf.settable && typeof entry.leaf.value === "number" && pattern.test(entry.key));
      if (found) return found;
    }
    return null;
  };
  const boost = entries.find((entry) => entry.characteristic.name === "powerfulMode" && entry.leaf.settable && isOnOff(entry.leaf));
  const power = named("onOffMode");
  const currentMode = mode ? String(shownValue(device, mode) ?? "") : "";
  return {
    point,
    entries,
    isTank,
    power: power?.leaf.settable && isOnOff(power.leaf) ? power : null,
    powerReading: power,
    mode: mode?.leaf.settable && Array.isArray(mode.leaf.values) && mode.leaf.values.length > 1 ? mode : null,
    currentMode,
    operation: entries.find((entry) => /operationstate/.test(entry.key)),
    reading: isTank ? readingFor([/tanktemperature/, /domestichotwatertemperature/]) : readingFor([/roomtemperature/, /leavingwatertemperature/]),
    setpoint: pickSetpoint(entries, currentMode),
    boost,
  };
}

function zones(device) {
  return (device.points || [])
    .filter((point) => !/gateway|indoorunit|outdoorunit/i.test(point.type || ""))
    .map((point) => zoneModel(device, point))
    .filter((zone) => zone.power || zone.setpoint || zone.reading || zone.point.schedule);
}

function alerts(device) {
  const flags = flattenDevice(device).filter((entry) => entry.leaf.value === true && /isinerrorstate|isinemergencystate|isinwarningstate|isincautionstate/.test(entry.key));
  return flags.map((entry) => {
    const code = pointEntries(entry.point).find((item) => /errorcode/.test(item.key) && item.leaf.value && item.leaf.value !== "-");
    const level = /error|emergency/.test(entry.key) ? "an error" : "a warning";
    return `<div class="notice error" role="alert"><strong>${escapeHtml(pointTitle(entry.point))} reports ${level}${code ? ` (${escapeHtml(code.leaf.value)})` : ""}.</strong> Check the indoor unit display, or contact your installer if it stays on.</div>`;
  }).join("");
}

/* ---------- Shared controls ---------- */

function toggleControl(device, entry, label) {
  const key = keyOf(device, entry);
  const on = isOn(shownValue(device, entry));
  return `<button class="toggle${state.writes.has(key) ? " is-pending" : ""}" role="switch" aria-checked="${on}" aria-label="${escapeHtml(label)}" data-command="toggle" data-key="${escapeHtml(key)}" data-focus="${escapeHtml(key)}"></button>`;
}

function choiceControl(device, entry, label) {
  const key = keyOf(device, entry);
  const current = String(shownValue(device, entry));
  const pending = state.writes.has(key) ? " is-pending" : "";
  if (entry.leaf.values.length > 4) {
    return `<select class="${pending}" aria-label="${escapeHtml(label)}" data-choice-key="${escapeHtml(key)}" data-focus="${escapeHtml(key)}">${entry.leaf.values.map((value, index) => `<option value="${index}" ${String(value) === current ? "selected" : ""}>${escapeHtml(modeLabel(value))}</option>`).join("")}</select>`;
  }
  return `<div class="segmented${pending}" role="radiogroup" aria-label="${escapeHtml(label)}">${entry.leaf.values.map((value, index) => `<button role="radio" aria-checked="${String(value) === current}" data-command="choose" data-key="${escapeHtml(key)}" data-index="${index}" data-focus="${escapeHtml(`${key}|${index}`)}">${escapeHtml(modeLabel(value))}</button>`).join("")}</div>`;
}

function stepValue(leaf) {
  return leaf.step || (leaf.unit === "°C" ? 0.5 : 1);
}

function stepperButtons(device, entry, value) {
  const key = keyOf(device, entry);
  const step = stepValue(entry.leaf);
  const down = Number(value) - step;
  const up = Number(value) + step;
  const atMin = Number.isFinite(entry.leaf.min) && down < entry.leaf.min - 1e-9;
  const atMax = Number.isFinite(entry.leaf.max) && up > entry.leaf.max + 1e-9;
  const label = readableLeaf(entry.characteristic, entry.leaf).toLowerCase();
  return [
    `<button class="step" data-command="step" data-dir="-1" data-key="${escapeHtml(key)}" data-focus="${escapeHtml(`${key}|down`)}" aria-label="Lower ${escapeHtml(label)} to ${escapeHtml(displayValue(entry.leaf, down))}" ${atMin ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>`,
    `<button class="step" data-command="step" data-dir="1" data-key="${escapeHtml(key)}" data-focus="${escapeHtml(`${key}|up`)}" aria-label="Raise ${escapeHtml(label)} to ${escapeHtml(displayValue(entry.leaf, up))}" ${atMax ? "disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg></button>`,
  ];
}

function inlineStepper(device, entry) {
  const value = shownValue(device, entry);
  const [down, up] = stepperButtons(device, entry, value);
  const pending = state.writes.get(keyOf(device, entry));
  return `<div class="stepper${pending ? " is-pending" : ""}">${down}<output aria-live="polite">${escapeHtml(displayValue(entry.leaf, value))}</output>${up}</div>`;
}

function writeStatus(device, entry) {
  const write = state.writes.get(keyOf(device, entry));
  if (!write) return "";
  return write.status === "sending" ? "Sending to heat pump…" : "Release to send";
}

/* ---------- Overview ---------- */

const ARC = "M 40.6 159.4 A 84 84 0 1 1 159.4 159.4";

function arcPoint(fraction) {
  const angle = ((135 + 270 * fraction) * Math.PI) / 180;
  return [100 + 84 * Math.cos(angle), 100 + 84 * Math.sin(angle)];
}

function dial(device, zone, on) {
  const { setpoint, reading } = zone;
  const readingName = reading ? readableLeaf(reading.characteristic, reading.leaf) : "";
  const readingText = reading ? `${readingName} ${displayValue(reading.leaf)}` : "";
  if (!setpoint) {
    return `<div class="dial is-readonly"><div class="dial-face"><span class="dial-caption">${escapeHtml(readingName || "Now")}</span><strong class="dial-number">${escapeHtml(reading ? displayValue(reading.leaf) : "—")}</strong><span class="dial-sub">No target advertised</span></div></div>`;
  }
  const leaf = setpoint.leaf;
  const value = Number(shownValue(device, setpoint));
  const kind = scaleFor(setpoint);
  const min = Number.isFinite(leaf.min) ? leaf.min : Math.floor(value - 10);
  const max = Number.isFinite(leaf.max) ? leaf.max : Math.ceil(value + 10);
  const fraction = clamp((value - min) / (max - min || 1), 0, 1);
  const readingValue = reading?.leaf.value;
  const sameScale = reading && kind !== "offset";
  const marker = sameScale && Number.isFinite(readingValue) ? arcPoint(clamp((readingValue - min) / (max - min || 1), 0, 1)) : null;
  const [down, up] = stepperButtons(device, setpoint, value);
  const status = writeStatus(device, setpoint);
  const caption = !on ? "Off" : status || (zone.isTank ? "Heat tank to" : kind === "offset" ? "Water offset" : `${modeLabel(zone.currentMode || "Target")} to`);
  return `<div class="dial">
    <svg viewBox="0 0 200 200" aria-hidden="true">
      <path class="dial-track" d="${ARC}" pathLength="100"/>
      <path class="dial-value" d="${ARC}" pathLength="100" stroke="${thermal(value, kind)}" stroke-dasharray="${(fraction * 100).toFixed(2)} 100"/>
      ${marker ? `<circle class="dial-reading" cx="${marker[0].toFixed(1)}" cy="${marker[1].toFixed(1)}" r="5.5"/>` : ""}
    </svg>
    <div class="dial-face">
      <span class="dial-caption">${escapeHtml(caption)}</span>
      <strong class="dial-number" aria-live="polite">${escapeHtml(displayValue(leaf, value).replace(/ °C$/, "°"))}</strong>
      ${readingText ? `<span class="dial-sub">${escapeHtml(readingText)}</span>` : ""}
    </div>
    <div class="dial-steps">${down}${up}</div>
  </div>`;
}

function zoneStatus(device, zone, on) {
  if (!on) return "Switched off";
  const operation = zone.operation?.leaf.value;
  if (operation) return sentenceCase(operation);
  return device.online ? "Ready" : "Unavailable";
}

function zoneCard(device, zone) {
  const title = pointTitle(zone.point);
  const on = zone.powerReading ? isOn(shownValue(device, zone.powerReading)) : true;
  return `<article class="zone${on ? "" : " is-off"}">
    <header class="zone-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(zoneStatus(device, zone, on))}</p></div>${zone.power ? toggleControl(device, zone.power, `${title} power`) : ""}</header>
    ${dial(device, zone, on)}
    ${zone.mode ? choiceControl(device, zone.mode, `${title} mode`) : ""}
    ${zone.boost ? `<div class="switch-row"><div><strong>Boost</strong><span>Heat the tank to its target now, once</span></div>${toggleControl(device, zone.boost, "Hot water boost")}</div>` : ""}
    ${zoneToday(device, zone)}
  </article>`;
}

function otherReadings(device, zoneList) {
  const primary = new Set(zoneList.map((zone) => zone.reading && keyOf(device, zone.reading)));
  const seen = new Set();
  return flattenDevice(device)
    .filter((entry) => !entry.leaf.settable && typeof entry.leaf.value === "number" && (entry.leaf.unit === "°C" || /temperature/.test(entry.key)))
    .filter((entry) => !primary.has(keyOf(device, entry)))
    .filter((entry) => {
      const label = readableLeaf(entry.characteristic, entry.leaf);
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    });
}

function overview(device) {
  if (device.source !== "cloud") return localOverview(device);
  const zoneList = zones(device);
  const readings = otherReadings(device, zoneList);
  const outside = readings.find((entry) => /outdoortemperature/.test(entry.key));
  const climate = zoneList.find((zone) => !zone.isTank);
  const summary = [
    climate ? zoneStatus(device, climate, climate.powerReading ? isOn(shownValue(device, climate.powerReading)) : true) : device.online ? "Online" : "Offline",
    outside ? `${displayValue(outside.leaf)} outside` : "",
  ].filter(Boolean).join(", ");
  return `<section class="page">${pageHead(device.name || "Home", `${summary}. Updated ${relativeTime(device.updatedAt)}.`, device)}
    ${notices()}${alerts(device)}${device.online ? "" : `<div class="notice">The heat pump is offline in Daikin's cloud. Readings may be out of date and changes may not arrive.</div>`}
    <div class="zones">${zoneList.map((zone) => zoneCard(device, zone)).join("") || `<article class="panel empty-card"><h2>No zones reported</h2><p>Daikin returned the device without heating or hot-water controls.</p></article>`}</div>
    ${readings.length ? `<dl class="readings">${readings.map((entry) => `<div><dt>${escapeHtml(readableLeaf(entry.characteristic, entry.leaf))}</dt><dd>${escapeHtml(displayValue(entry.leaf))}</dd></div>`).join("")}</dl>` : ""}
    ${energyPanel(device)}
    ${efficiencyPanel()}
  </section>`;
}

/* ---------- Efficiency suggestions ---------- */

const ROUTE_NAMES = { controls: "Open controls", schedule: "Open schedule" };
const SETTING_NAMES = { roomTemperature: "room target", domesticHotWaterTemperature: "tank target", leavingWaterOffset: "water offset", onOffMode: "power", operationMode: "mode", powerfulMode: "boost" };

function changeText(change) {
  const last = String(change.setting || "").split("/").filter(Boolean);
  const name = SETTING_NAMES[last.at(-1)] || (last[0] === "schedule" ? "schedule" : sentenceCase(last.at(-1) || "setting").toLowerCase());
  const value = (item) => (typeof item === "number" ? `${formatNumber(item)}` : typeof item === "object" && item ? (item.enabled === false ? "paused" : "on") : sentenceCase(item ?? "—").toLowerCase());
  const date = new Date(change.t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${date}: ${sentenceCase(change.point === "domesticHotWaterTank" ? "hot water" : "heating")} ${name}${change.from !== undefined ? ` ${value(change.from)} to` : ""} ${value(change.to)}`;
}

function degreeDayChart(stats) {
  const months = stats.filter((month) => month.kwhPerHdd !== null).slice(-12);
  if (months.length < 2) return "";
  const max = Math.max(...months.map((month) => month.kwhPerHdd)) * 1.1;
  const slot = 100 / months.length;
  const bars = months.map((month, index) => {
    const height = (month.kwhPerHdd / max) * 100;
    return `<rect class="bar-now" x="${(index * slot + slot * 0.25).toFixed(2)}%" width="${(slot * 0.5).toFixed(2)}%" y="${(100 - height).toFixed(2)}%" height="${height.toFixed(2)}%" rx="3"/>`;
  }).join("");
  // Heating months skip summer, so the year is shown wherever it changes.
  const label = (month, index) => new Date(`${month.month}-15T12:00:00Z`).toLocaleDateString(undefined, index === 0 || month.month.endsWith("-01") ? { month: "short", year: "numeric" } : { month: "short" });
  const ticks = months.map((month, index) => `<text x="${((index + 0.5) * slot).toFixed(2)}%" y="14" text-anchor="middle">${escapeHtml(label(month, index))}</text>`).join("");
  const latest = months.at(-1);
  return `<div class="hdd-chart">
    <p><strong>${escapeHtml(formatNumber(latest.kwhPerHdd, 0.01))} kWh</strong> of heating electricity per degree-day in ${escapeHtml(new Date(`${latest.month}-15T12:00:00Z`).toLocaleDateString(undefined, { month: "long" }))}. Lower is better. This evens out mild and cold months, so compare it before and after each change.</p>
    <svg class="energy-chart short" role="img" aria-label="${escapeHtml(months.map((month, index) => `${label(month, index)} ${formatNumber(month.kwhPerHdd, 0.01)}`).join(", "))}">${bars}</svg>
    <svg class="energy-ticks" aria-hidden="true">${ticks}</svg>
  </div>`;
}

function efficiencyPanel() {
  const data = state.efficiency;
  if (!data) return "";
  const { stats = [], changes = [] } = data;
  const findings = (data.findings || []).filter((item) => !item.setAside);
  const setAside = (data.findings || []).filter((item) => item.setAside);
  const count = findings.filter((item) => item.severity !== "info").length;
  const summary = findings.length
    ? `${count ? `${count} change${count === 1 ? "" : "s"} worth trying` : "Nothing urgent"}, based on the current settings${data.samples ? ` and ${data.samples} readings` : ""}. Try one at a time and give each a week.`
    : setAside.length ? "Nothing else to change right now." : "Nothing to change right now. The settings Daikin reports look efficient.";
  return `<article class="panel efficiency">
    <header class="panel-head"><div><h2>Ways to use less energy</h2><p>${escapeHtml(summary)}</p></div></header>
    ${data.profileComplete ? "" : `<p class="profile-hint">Add your home's details in <a href="#system">System</a> so suggestions match your house and weather.</p>`}
    ${findings.length ? `<ul class="findings">${findings.map((item) => `<li class="finding is-${escapeHtml(item.severity)}">
      <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.evidence)}</p><p>${escapeHtml(item.suggestion)}</p>${item.estimate ? `<span class="estimate">Estimate: ${escapeHtml(item.estimate)}</span>` : ""}</div>
      <div class="finding-actions">${item.control ? `<a class="secondary" href="#${escapeHtml(item.control)}">${escapeHtml(ROUTE_NAMES[item.control] || "Open")}</a>` : ""}<button class="text-button" data-command="set-aside" data-finding="${escapeHtml(item.id)}">Not now</button></div>
    </li>`).join("")}</ul>` : ""}
    ${setAside.length ? `<details class="change-log"><summary>Set aside for now <span>${setAside.length}</span></summary><ul class="set-aside">${setAside.map((item) => `<li><span>${escapeHtml(item.title)}</span><button class="text-button" data-command="bring-back" data-finding="${escapeHtml(item.id)}">Bring back</button></li>`).join("")}</ul></details>` : ""}
    ${degreeDayChart(stats)}
    ${data.weather?.error ? `<p class="muted">Weather history is unavailable: ${escapeHtml(data.weather.error)}</p>` : ""}
    ${changes.length ? `<details class="change-log"><summary>Recent changes <span>${changes.length}</span></summary><ul>${changes.slice().reverse().slice(0, 10).map((change) => `<li>${escapeHtml(changeText(change))}</li>`).join("")}</ul></details>` : ""}
  </article>`;
}

/* ---------- Energy ---------- */

const PERIODS = {
  d: { label: "Day", size: 12, current: "Today", previous: "yesterday", ticks: (i) => (i % 3 === 0 ? String(i * 2).padStart(2, "0") : "") },
  w: { label: "Week", size: 7, current: "This week", previous: "last week", ticks: (i) => dayLabels[days[i]] },
  m: { label: "Year", size: 12, current: "This year", previous: "last year", ticks: (i) => "JFMAMJJASOND"[i] },
};

function energySeries(device) {
  const leaves = flattenDevice(device).filter((entry) => Array.isArray(entry.leaf.value) && /\/electrical\/[^/]+\/[dwm]$/.test(entry.leaf.path || ""));
  if (!leaves.length) return null;
  const period = PERIODS[state.energyPeriod];
  const sum = (offset) => Array.from({ length: period.size }, (_, index) => {
    const values = leaves
      .filter((entry) => entry.leaf.path.endsWith(`/${state.energyPeriod}`))
      .map((entry) => entry.leaf.value[offset + index])
      .filter((value) => typeof value === "number");
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  });
  const parts = leaves.filter((entry) => entry.leaf.path.endsWith(`/${state.energyPeriod}`)).map((entry) => {
    const mode = entry.leaf.path.split("/").at(-2);
    const name = /domestichotwater/i.test(entry.point.type) ? "Hot water" : mode === "cooling" ? "Cooling" : "Space heating";
    const total = entry.leaf.value.slice(period.size).filter((value) => typeof value === "number").reduce((a, b) => a + b, 0);
    return { name, total };
  }).filter((part) => part.total > 0);
  return { previous: sum(0), current: sum(period.size), parts, unit: leaves[0].leaf.unit || "kWh", period };
}

function energyPanel(device) {
  const series = energySeries(device);
  if (!series) return "";
  const { previous, current, period, unit } = series;
  const total = (values) => values.filter((value) => value !== null).reduce((a, b) => a + b, 0);
  const max = Math.max(0.1, ...previous.filter((v) => v !== null), ...current.filter((v) => v !== null));
  const slot = 100 / period.size;
  const bars = current.map((value, index) => {
    const x = index * slot;
    const before = previous[index];
    return `${before !== null ? `<rect class="bar-prev" x="${(x + slot * 0.14).toFixed(2)}%" width="${(slot * 0.72).toFixed(2)}%" y="${(100 - (before / max) * 100).toFixed(2)}%" height="${((before / max) * 100).toFixed(2)}%" rx="3"/>` : ""}
      ${value !== null ? `<rect class="bar-now" x="${(x + slot * 0.3).toFixed(2)}%" width="${(slot * 0.4).toFixed(2)}%" y="${(100 - (value / max) * 100).toFixed(2)}%" height="${((value / max) * 100).toFixed(2)}%" rx="3"/>` : ""}`;
  }).join("");
  const ticks = current.map((_, index) => `<text x="${((index + 0.5) * slot).toFixed(2)}%" y="14" text-anchor="middle">${escapeHtml(period.ticks(index))}</text>`).join("");
  const now = total(current);
  const then = total(previous);
  return `<article class="panel energy">
    <header class="panel-head"><div><h2>Electricity used</h2><p>${escapeHtml(period.current)}: <strong>${escapeHtml(formatNumber(now, 0.1))} ${escapeHtml(unit)}</strong>, ${escapeHtml(period.previous)} ${escapeHtml(formatNumber(then, 0.1))} ${escapeHtml(unit)}</p></div>
      <div class="segmented compact" role="radiogroup" aria-label="Energy period">${Object.entries(PERIODS).map(([id, item]) => `<button role="radio" aria-checked="${id === state.energyPeriod}" data-command="energy-period" data-period="${id}" data-focus="energy-${id}">${item.label}</button>`).join("")}</div>
    </header>
    <svg class="energy-chart" role="img" aria-label="${escapeHtml(`${period.current} ${formatNumber(now, 0.1)} ${unit}, ${period.previous} ${formatNumber(then, 0.1)} ${unit}`)}">${bars}</svg>
    <svg class="energy-ticks" aria-hidden="true">${ticks}</svg>
    <p class="legend"><span class="key-now"></span>${escapeHtml(period.current)}<span class="key-prev"></span>${escapeHtml(sentenceCase(period.previous))}${series.parts.length > 1 ? ` <em>${series.parts.map((part) => `${escapeHtml(part.name)} ${escapeHtml(formatNumber(part.total, 0.1))} ${escapeHtml(unit)}`).join(", ")}</em>` : ""}</p>
  </article>`;
}

/* ---------- Schedules ---------- */

function scheduleModes(schedule) {
  const value = unbox(schedule?.value) || {};
  return unbox(value.modes) || {};
}

function modeSchedule(point, mode, data) {
  const currentNode = data.currentSchedule || {};
  const current = String(unbox(currentNode) ?? "0");
  const definitions = unbox(data.schedules) || {};
  return {
    point,
    mode,
    current,
    enabled: Boolean(unbox(data.enabled)),
    choices: (currentNode.values || Object.keys(definitions)).map(String),
    definitions,
    week: weekEvents(definitions[current]),
    editable: Boolean(weeklyDefinition(definitions[current])),
  };
}

function pointSchedules(point) {
  return Object.entries(scheduleModes(point.schedule)).map(([mode, data]) => modeSchedule(point, mode, unbox(data) || {}));
}

function weekEvents(definition) {
  const value = unbox(definition) || {};
  if (!days.some((day) => Object.hasOwn(value, day))) return null;
  return Object.fromEntries(days.map((day) => {
    const events = unbox(value[day]);
    return [day, (Array.isArray(events) ? events : []).map((node) => {
      const item = unbox(node) || {};
      return { time: formatTime(unbox(item.time ?? item.startTime ?? item.StartTime) ?? ""), target: unbox(item.value ?? item.temperature ?? item.targetTemperature ?? item.TargetTemperature) };
    }).filter((event) => toMinutes(event.time) !== null).sort((a, b) => toMinutes(a.time) - toMinutes(b.time))];
  }));
}

function scheduleName(definition, fallback) {
  const name = unbox(unbox(definition)?.name);
  return name ? String(name) : `Programme ${fallback}`;
}

function toMinutes(time) {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(String(time));
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : null;
}

function formatTime(value) {
  const text = String(value);
  return /^\d{4}$/.test(text) ? `${text.slice(0, 2)}:${text.slice(2)}` : text;
}

function todayKey(date = new Date()) {
  return days[(date.getDay() + 6) % 7];
}

function carryIn(week, day) {
  const index = days.indexOf(day);
  for (let back = 1; back <= 7; back += 1) {
    const events = week[days[(index - back + 7) % 7]] || [];
    if (events.length) return events.at(-1).target;
  }
  return null;
}

function targetText(target) {
  return typeof target === "number" ? `${formatNumber(target)}°` : sentenceCase(target);
}

function timeline(week, day, { now = false, kind } = {}) {
  const events = week[day] || [];
  const segments = [];
  let start = 0;
  let value = carryIn(week, day);
  for (const event of events) {
    const at = toMinutes(event.time);
    if (at > start) segments.push({ start, end: at, value });
    start = at;
    value = event.target;
  }
  segments.push({ start, end: 1440, value });
  const pct = (minutes) => ((minutes / 1440) * 100).toFixed(3);
  const rects = segments.map((segment) => {
    const color = segment.value === null || segment.value === undefined ? "#9aa7ad" : thermal(segment.value, kind);
    const width = segment.end - segment.start;
    return `<rect class="band" x="${pct(segment.start)}%" width="${pct(width)}%" y="0" height="100%" fill="${color}"/>
      <rect x="${pct(segment.start)}%" width="${pct(width)}%" y="0" height="4" fill="${color}"/>
      ${width >= 150 && segment.value !== null ? `<text x="${pct(segment.start + 6)}%" y="24">${escapeHtml(targetText(segment.value))}</text>` : ""}`;
  }).join("");
  const minutesNow = new Date().getHours() * 60 + new Date().getMinutes();
  const label = events.length ? events.map((event) => `${event.time} ${targetText(event.target)}`).join(", ") : "no changes";
  return `<svg class="timeline" role="img" aria-label="${escapeHtml(`${dayLabels[day]}: ${label}`)}">${rects}${now ? `<line class="now" x1="${pct(minutesNow)}%" x2="${pct(minutesNow)}%" y1="0" y2="100%"/>` : ""}</svg>`;
}

function hourAxis() {
  return `<svg class="hour-axis" aria-hidden="true">${[0, 6, 12, 18, 24].map((hour) => `<text x="${(hour / 24) * 100}%" y="12" text-anchor="${hour === 0 ? "start" : hour === 24 ? "end" : "middle"}">${String(hour).padStart(2, "0")}:00</text>`).join("")}</svg>`;
}

function nextChange(week) {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = days.indexOf(todayKey(now));
  for (let ahead = 0; ahead < 7; ahead += 1) {
    const day = days[(start + ahead) % 7];
    const event = (week[day] || []).find((item) => ahead > 0 || toMinutes(item.time) > minutes);
    if (event) return `${targetText(event.target)} at ${event.time}${ahead === 0 ? "" : ahead === 1 ? " tomorrow" : ` on ${dayLabels[day]}`}`;
  }
  return "";
}

function zoneToday(device, zone) {
  if (!zone.point.schedule) return "";
  const modes = pointSchedules(zone.point);
  const active = modes.find((item) => item.mode === zone.currentMode && item.enabled) || modes.find((item) => item.enabled);
  if (!active) return `<a class="zone-schedule" href="#schedule"><span>Schedule paused</span></a>`;
  if (!active.week) return `<a class="zone-schedule" href="#schedule"><span>Following ${escapeHtml(scheduleName(active.definitions[active.current], active.current))}</span></a>`;
  const next = nextChange(active.week);
  return `<a class="zone-schedule" href="#schedule" aria-label="Open schedule">
    ${timeline(active.week, todayKey(), { now: true, kind: zone.isTank ? "water" : undefined })}
    <span>${escapeHtml(scheduleName(active.definitions[active.current], active.current))}${next ? `, next ${escapeHtml(next)}` : ""}</span>
  </a>`;
}

/* ---------- Controls ---------- */

function controls(device) {
  if (device.source !== "cloud") return localControls(device);
  const zoneList = zones(device).filter((zone) => zone.entries.some((entry) => entry.leaf.settable));
  return `<section class="page">${pageHead("Controls", "Every setting your heat pump lets you change remotely.", device)}${notices()}
    ${zoneList.length ? `<div class="control-stack">${zoneList.map((zone) => zoneControls(device, zone)).join("")}</div>` : `<article class="panel empty-card"><h2>No remote settings</h2><p>Daikin reports readings for this heat pump but no settings that can be changed remotely.</p></article>`}
    ${readingsDrawer(device)}
  </section>`;
}

function zoneControls(device, zone) {
  const title = pointTitle(zone.point);
  const settable = zone.entries.filter((entry) => entry.leaf.settable);
  const rows = settable.map((entry) => controlRow(device, zone, entry)).filter(Boolean).join("");
  return `<article class="panel">
    <header class="panel-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(zoneStatus(device, zone, zone.powerReading ? isOn(shownValue(device, zone.powerReading)) : true))}</p></div></header>
    <div class="control-list">${rows}</div>
  </article>`;
}

function inactiveMode(zone, entry) {
  const match = /\/operationmodes\/([^/]+)\//.exec(entry.key);
  if (!match || !zone.currentMode) return "";
  return match[1] === zone.currentMode.toLowerCase() ? "" : match[1];
}

function controlRow(device, zone, entry) {
  const { characteristic, leaf } = entry;
  const label = entry === zone.power ? "Power" : readableLeaf(characteristic, leaf);
  const idle = inactiveMode(zone, entry);
  const hint = idle ? `Used when the mode is ${modeLabel(idle).toLowerCase()}` : typeof leaf.value === "number" && Number.isFinite(leaf.min) && Number.isFinite(leaf.max) ? `${displayValue({ ...leaf, step: 0 }, leaf.min)} to ${displayValue({ ...leaf, step: 0 }, leaf.max)}` : entry === zone.boost ? "Heat the tank to its target now, once" : "";
  let control = "";
  if (isOnOff(leaf)) control = toggleControl(device, entry, `${pointTitle(zone.point)} ${label}`);
  else if (Array.isArray(leaf.values) && leaf.values.length) control = choiceControl(device, entry, label);
  else if (typeof leaf.value === "number") control = inlineStepper(device, entry);
  else if (typeof leaf.value === "string") control = `<form class="text-control" data-text-key="${escapeHtml(keyOf(device, entry))}"><input name="value" value="${escapeHtml(leaf.value)}" aria-label="${escapeHtml(label)}"><button class="secondary">Save</button></form>`;
  if (!control) return "";
  const status = writeStatus(device, entry);
  return `<div class="control-row${idle ? " is-idle" : ""}"><div><strong>${escapeHtml(label)}</strong>${status || hint ? `<span>${escapeHtml(status || hint)}</span>` : ""}</div>${control}</div>`;
}

function readingsDrawer(device) {
  const readOnly = flattenDevice(device).filter((entry) => !entry.leaf.settable && ["string", "number", "boolean"].includes(typeof entry.leaf.value) && !/errorcode|isin\w+state/.test(entry.key));
  if (!readOnly.length) return "";
  return `<details class="drawer"><summary>All readings <span>${readOnly.length}</span></summary><dl class="drawer-grid">${readOnly.map((entry) => `<div><dt>${escapeHtml(pointTitle(entry.point))}, ${escapeHtml(readableLeaf(entry.characteristic, entry.leaf).toLowerCase())}</dt><dd>${escapeHtml(displayValue(entry.leaf))}</dd></div>`).join("")}</dl></details>`;
}

/* ---------- Schedule page ---------- */

function schedule(device) {
  if (device.source !== "cloud") return localSchedule(device);
  const items = (device.points || []).filter((point) => point.schedule).flatMap((point) => pointSchedules(point).map((item) => ({ ...item, settable: Boolean(point.schedule.settable) })));
  return `<section class="page">${pageHead("Schedule", "When your home warms up and cools down through the week.", device)}${notices()}
    ${items.length ? `<div class="control-stack">${items.map((item) => schedulePanel(device, item)).join("")}</div>` : `<article class="panel empty-card"><h2>No schedules reported</h2><p>Daikin doesn't offer a remote schedule for this heat pump.</p></article>`}
  </section>`;
}

function schedulePanel(device, item) {
  const { point, mode, current, enabled, choices, definitions, settable } = item;
  const draft = state.scheduleDraft?.deviceId === device.id && state.scheduleDraft?.pointId === point.id && state.scheduleDraft?.mode === item.mode ? state.scheduleDraft : null;
  const kind = /domestichotwater/i.test(point.type || "") ? "water" : undefined;
  const data = `data-device="${escapeHtml(device.id)}" data-point="${escapeHtml(point.id)}" data-mode="${escapeHtml(mode)}"`;
  const today = todayKey();
  const picker = settable && choices.length > 1
    ? `<div class="segmented compact" role="radiogroup" aria-label="Programme">${choices.map((id) => `<button role="radio" aria-checked="${id === current}" data-command="schedule-pick" data-schedule="${escapeHtml(id)}" ${data} ${draft ? "disabled" : ""}>${escapeHtml(scheduleName(definitions[id], id))}</button>`).join("")}</div>`
    : `<span class="chip">${escapeHtml(scheduleName(definitions[current], current))}</span>`;
  const body = draft ? weeklyEditor(draft, kind) : item.week
    ? `<div class="week">${days.map((day) => `<div class="week-row${day === today ? " is-today" : ""}"><span>${dayLabels[day]}</span>${timeline(item.week, day, { now: day === today, kind })}</div>`).join("")}<div class="week-row axis"><span></span>${hourAxis()}</div></div>`
    : `<p class="muted">This programme can't be shown day by day.</p>`;
  return `<article class="panel schedule-panel">
    <header class="panel-head"><div><h2>${escapeHtml(pointTitle(point))}, ${escapeHtml(modeLabel(mode).toLowerCase())}</h2><p>${enabled ? `Following the schedule${item.week ? `, next ${escapeHtml(nextChange(item.week) || "change not set")}` : ""}` : "Paused. The heat pump holds its current target."}</p></div>
      ${settable ? `<div class="switch-inline"><span>Follow schedule</span><button class="toggle" role="switch" aria-checked="${enabled}" aria-label="Follow ${escapeHtml(modeLabel(mode).toLowerCase())} schedule" data-command="schedule-enable" data-schedule="${escapeHtml(current)}" data-enabled="${!enabled}" ${data} ${draft ? "disabled" : ""}></button></div>` : ""}
    </header>
    <div class="schedule-tools">${picker}${settable && item.editable && !draft ? `<button class="secondary" data-command="schedule-edit" data-schedule="${escapeHtml(current)}" ${data}>Edit ${escapeHtml(scheduleName(definitions[current], current))}</button>` : ""}</div>
    ${body}
  </article>`;
}

function isValueWrapper(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "value")) return false;
  const wrapperKeys = new Set(["value", "settable", "values", "unit", "minValue", "maxValue", "stepValue", "ref"]);
  return Object.keys(value).every((key) => wrapperKeys.has(key));
}

function replaceBox(original, value) {
  return isValueWrapper(original) ? { ...original, value } : value;
}

function weeklyDefinition(definition) {
  const value = unbox(definition) || {};
  if (!days.some((day) => Object.hasOwn(value, day))) return null;
  const result = {};
  for (const day of days) {
    const events = unbox(value[day]) || [];
    if (!Array.isArray(events)) return null;
    result[day] = [];
    for (const eventNode of events) {
      const event = unbox(eventNode);
      if (!event || typeof event !== "object") return null;
      const timeKey = ["time", "startTime", "StartTime"].find((key) => Object.hasOwn(event, key));
      const targetKey = ["value", "temperature", "targetTemperature", "TargetTemperature"].find((key) => Object.hasOwn(event, key));
      if (!timeKey || !targetKey) return null;
      const target = Number(unbox(event[targetKey]));
      if (!Number.isFinite(target)) return null;
      result[day].push({ time: formatTime(unbox(event[timeKey])), target });
    }
  }
  return result;
}

function weeklyEditor(draft, kind) {
  return `<div class="weekly-editor">
    ${days.map((day) => `<section class="editor-day" data-editor-day="${day}">
      <div class="editor-day-head"><strong>${dayLabels[day]}</strong><div class="editor-copy"><button class="text-button" data-command="schedule-copy" data-day="${day}" data-to="weekdays">Copy to weekdays</button><button class="text-button" data-command="schedule-copy" data-day="${day}" data-to="all">Copy to every day</button></div></div>
      ${timeline(draft.days, day, { kind })}
      <div class="editor-events">${draft.days[day].map((event, index) => scheduleEventRow(day, index, event)).join("")}<button class="add-change" data-command="schedule-add" data-day="${day}" data-focus="add-${day}">Add change</button></div>
    </section>`).join("")}
    <div class="editor-footer"><button class="primary" data-command="schedule-save">Save ${escapeHtml(draft.name)}</button><button class="secondary" data-command="schedule-cancel">Discard changes</button><span>Nothing is sent to the heat pump until you save.</span></div>
  </div>`;
}

function scheduleEventRow(day, index, event) {
  return `<div class="editor-event" data-event-index="${index}"><label><span>From</span><input type="time" data-event-time value="${escapeHtml(event.time)}" data-focus="ed-${day}-${index}-time"></label><label><span>Target</span><input type="number" inputmode="decimal" data-event-target value="${escapeHtml(event.target)}" step="0.5" data-focus="ed-${day}-${index}-target"><i>°C</i></label><button class="remove-button" data-command="schedule-remove" data-day="${day}" data-index="${index}" aria-label="Remove ${dayLabels[day]} change at ${escapeHtml(event.time)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>`;
}

function captureScheduleDraft() {
  const container = app.querySelector(".weekly-editor");
  if (!state.scheduleDraft || !container) return;
  for (const day of days) {
    state.scheduleDraft.days[day] = [...container.querySelectorAll(`[data-editor-day="${day}"] .editor-event`)].map((row) => ({
      time: row.querySelector("[data-event-time]").value,
      target: Number(row.querySelector("[data-event-target]").value),
    }));
  }
}

function rebuildWeeklyDefinitions(draft) {
  const definitions = structuredClone(draft.definitions);
  const originalDefinition = definitions[draft.scheduleId];
  const definition = structuredClone(unbox(originalDefinition) || {});
  for (const day of days) {
    const originalDayNode = definition[day];
    const originalEvents = unbox(originalDayNode) || [];
    const nextEvents = draft.days[day].map((item, index) => {
      const originalNode = originalEvents[index];
      const original = structuredClone(unbox(originalNode) || {});
      const timeKey = ["time", "startTime", "StartTime"].find((key) => Object.hasOwn(original, key)) || "time";
      const targetKey = ["value", "temperature", "targetTemperature", "TargetTemperature"].find((key) => Object.hasOwn(original, key)) || "value";
      original[timeKey] = replaceBox(original[timeKey], item.time);
      original[targetKey] = replaceBox(original[targetKey], item.target);
      return replaceBox(originalNode, original);
    });
    definition[day] = replaceBox(originalDayNode, nextEvents);
  }
  definitions[draft.scheduleId] = replaceBox(originalDefinition, definition);
  return definitions;
}

/* ---------- Local adapter (BRP069A61/A62) ---------- */

function localOverview(device) {
  const space = device.controls?.space || {};
  const tank = device.controls?.tank || {};
  return `<section class="page">${pageHead(device.name || "Home", `${space.operationMode ? sentenceCase(space.operationMode) : "Ready"}. Connected on your home network.`, device)}
    <dl class="readings">${[["Room", space.indoorTemperature], ["Outside", space.outdoorTemperature], ["Tank", tank.temperature], ["Room target", space.targetTemperature], ["Tank target", tank.targetTemperature]].filter(([, value]) => value !== undefined).map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(formatNumber(value))}°</dd></div>`).join("")}</dl>
  </section>`;
}

function localControls(device) {
  const space = device.controls?.space || {};
  const tank = device.controls?.tank || {};
  return `<section class="page">${pageHead("Controls", "Settings sent directly over your home network.", device)}
    <div class="control-stack"><article class="panel"><header class="panel-head"><div><h2>Heating</h2></div></header><div class="control-list">${localNumberControl("Room target", "space.targetTemperature", space.targetTemperature, 0.5)}${localNumberControl("Weather curve offset", "space.leavingWaterOffset", space.leavingWaterOffset, 1)}</div></article>
    <article class="panel"><header class="panel-head"><div><h2>Hot water</h2></div></header><div class="control-list">${localNumberControl("Tank target", "tank.targetTemperature", tank.targetTemperature, 1)}</div></article></div></section>`;
}

function localNumberControl(label, action, value, step) {
  return `<div class="control-row"><div><strong>${escapeHtml(label)}</strong></div><div class="stepper"><button class="step" data-action="${escapeHtml(action)}" data-value="${Number(value) - step}" aria-label="Lower ${escapeHtml(label.toLowerCase())}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button><output>${escapeHtml(value)}°</output><button class="step" data-action="${escapeHtml(action)}" data-value="${Number(value) + step}" aria-label="Raise ${escapeHtml(label.toLowerCase())}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12"/></svg></button></div></div>`;
}

function localSchedule(device) {
  const week = Object.fromEntries(days.map((day) => [day, (device.schedules?.space?.[day] || []).map((slot) => ({ time: slot.time, target: slot.value }))]));
  const today = todayKey();
  return `<section class="page">${pageHead("Schedule", "Heating programme stored on the local adapter.", device)}
    <article class="panel schedule-panel"><div class="week">${days.map((day) => `<div class="week-row${day === today ? " is-today" : ""}"><span>${dayLabels[day]}</span>${timeline(week, day, { now: day === today })}<button class="text-button" data-command="add-slot" data-day="${day}">Add</button></div>`).join("")}<div class="week-row axis"><span></span>${hourAxis()}</div></div>
    <div class="editor-footer"><button class="primary" data-command="save-schedule">Save schedule</button></div></article></section>`;
}

/* ---------- Waiting and system ---------- */

function waitingForGateway() {
  const cloud = state.settings?.onecta || {};
  const steps = [
    { label: "Connect your Daikin account", done: Boolean(cloud.connected) },
    { label: "Daikin releases the Wi-Fi adapter from its previous owner", done: false },
    { label: "Add the heat pump in the ONECTA app", done: false },
  ];
  const current = steps.findIndex((step) => !step.done);
  return `<section class="page">${notices()}${pageHead(cloud.connected ? "Waiting for your heat pump" : "Connect your heat pump", cloud.connected
    ? "Your Daikin account is connected, but it doesn't list a heat pump yet. Controls appear here as soon as it does."
    : "Sign in with the Daikin account that owns the heat pump. Controls appear once Daikin lists it.")}
    <article class="panel waiting">
      <ol class="steps">${steps.map((step, index) => `<li class="${step.done ? "done" : index === current ? "current" : ""}"><span>${step.done ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>` : index + 1}</span>${escapeHtml(step.label)}</li>`).join("")}</ol>
      <div class="button-row">${cloud.connected ? `<button class="primary" data-command="reload">Check again</button><a class="secondary" href="#system">Connection details</a>` : `<a class="primary" href="#system">Set up connection</a>`}</div>
    </article></section>`;
}

function system(device) {
  const settings = state.settings || {};
  const cloud = settings.onecta || {};
  const localReachability = settings.server?.localReachability !== false;
  const gateway = state.gatewayCheck || (settings.local?.host && settings.local?.protocol ? {
    status: "reachable",
    host: settings.local.host,
    model: settings.local.adapterModel,
    checkedAt: settings.local.checkedAt,
  } : { status: "unknown", host: settings.local?.host || "" });
  const { remainingDay, limitDay, remainingMinute, limitMinute } = state.rateLimit;
  const accountState = cloud.connected ? (state.devices.length ? "Connected" : "Connected, no heat pump listed yet") : cloud.configured ? "Ready to sign in" : "Not set up";
  const usage = Number.isFinite(remainingDay) && Number.isFinite(limitDay) ? clamp(1 - remainingDay / limitDay, 0, 1) : null;
  const gatewayCard = localReachability ? `<article class="panel">
      <header class="panel-head"><div><h2>Wi-Fi adapter</h2><p>Checks whether the adapter answers on your home network. Nothing is changed on the heat pump.</p></div><span class="status-dot ${gateway.status}">${gateway.status === "reachable" ? "Reachable" : gateway.status === "unreachable" ? "No response" : "Not checked"}</span></header>
      <form id="gateway-check" class="inline-form"><label><span>Adapter IP address</span><input name="host" required inputmode="decimal" placeholder="192.168.1.42" value="${escapeHtml(gateway.host || "")}" autocomplete="off"></label><button class="primary">Check adapter</button></form>
      ${gateway.status === "reachable" ? `<p class="muted">${escapeHtml(gateway.model || "Daikin Wi-Fi adapter")} answered ${gateway.checkedAt ? escapeHtml(relativeTime(gateway.checkedAt)) : "just now"}.</p>` : gateway.status === "unreachable" ? `<p class="muted">No answer. Check the address and that this Mac is on your home Wi-Fi.</p>` : ""}
    </article>` : `<article class="panel"><header class="panel-head"><div><h2>Wi-Fi adapter</h2><p>This hosted dashboard talks only to Daikin's cloud and never reaches into your home network. Adapter checks are available from the dashboard on your Mac.</p></div><span class="status-dot local-only">Home network only</span></header></article>`;
  return `<section class="page">${pageHead("System", "Daikin account, API usage and the Wi-Fi adapter.", device)}${notices()}
    <div class="system-grid">
      <article class="panel">
        <header class="panel-head"><div><h2>Daikin account</h2><p>${escapeHtml(accountState)}</p></div><span class="status-dot ${cloud.connected ? "reachable" : "unknown"}">${cloud.connected ? "Signed in" : "Signed out"}</span></header>
        <dl class="facts">
          <div><dt>Heat pumps listed</dt><dd>${state.devices.filter((item) => item.source === "cloud").length}</dd></div>
          ${Number.isFinite(remainingMinute) ? `<div><dt>Requests left this minute</dt><dd>${remainingMinute} of ${limitMinute ?? "—"}</dd></div>` : ""}
          ${usage !== null ? `<div><dt>Requests left today</dt><dd>${remainingDay} of ${limitDay}</dd></div>` : ""}
        </dl>
        ${usage !== null ? `<svg class="quota" role="img" aria-label="${escapeHtml(`${Math.round(usage * 100)}% of today's Daikin requests used`)}"><rect class="quota-track" width="100%" height="100%" rx="4"/><rect class="quota-used${usage > 0.85 ? " is-high" : ""}" width="${(usage * 100).toFixed(1)}%" height="100%" rx="4"/></svg><p class="muted">Readings are cached for 8 minutes so normal use stays within Daikin's daily limit.</p>` : ""}
        <div class="button-row">${cloud.configured ? `<a class="primary" href="/api/cloud/connect">${cloud.connected ? "Sign in again" : "Sign in with Daikin"}</a>` : ""}<button class="secondary" data-command="reload">Refresh now</button></div>
      </article>
      <details class="panel credentials" ${cloud.configured ? "" : "open"}><summary><div><h2>Developer app</h2><p>Client ID and secret from the Daikin developer portal, stored encrypted.</p></div><span class="chip">${cloud.configured ? "Edit" : "Set up"}</span></summary>
        <form id="cloud-settings" class="settings-form"><label><span>Client ID</span><input name="clientId" value="${escapeHtml(cloud.clientId || "")}" autocomplete="off"></label><label><span>Client secret</span><input type="password" name="clientSecret" placeholder="${cloud.hasClientSecret ? "Saved. Leave blank to keep it." : "Required"}" autocomplete="new-password"></label><label><span>Redirect URI to register with Daikin</span><input readonly value="${escapeHtml(cloud.redirectUri || "")}"></label><button class="primary">Save credentials</button></form>
      </details>
    </div>
    ${houseForm(settings.house || {})}
    ${gatewayCard}
    ${cloud.connected ? `<details class="drawer danger-zone"><summary>Disconnect Daikin account</summary><div><p>Removes the saved Daikin sign-in from this dashboard. The heat pump stays in your Daikin account, and Daikin keeps the session active until it expires.</p><button class="danger" data-command="cloud-disconnect">Disconnect</button></div></details>` : ""}
  </section>`;
}

const HOUSE_OPTIONS = {
  emitters: [["underfloor", "Underfloor heating"], ["radiators", "Radiators"], ["mixed", "Underfloor and radiators"], ["fancoil", "Fan coils"]],
  tariff: [["flat", "Same price all day"], ["dual", "Cheaper at night"], ["dynamic", "Hourly market price"]],
  solar: [["none", "No solar"], ["pv", "Solar panels"], ["pvBattery", "Solar panels and battery"]],
  insulation: [["poor", "Little or none"], ["average", "Average"], ["renovated", "Renovated, insulated"], ["new", "New build, well insulated"]],
  roomThermostats: [["none", "No room thermostats"], ["some", "In some rooms"], ["all", "In every room"]],
  belowFloor: [["ground", "Ground (slab on soil)"], ["basement", "Unheated basement"], ["heated", "Another heated floor"]],
  ventilation: [["windows", "Opening windows"], ["extract", "Extract fans"], ["recovery", "Heat-recovery ventilation"]],
};
const HOUSE_DEFAULTS = { emitters: "underfloor", tariff: "flat", solar: "none", insulation: "new", roomThermostats: "all", belowFloor: "basement", ventilation: "windows" };

function roomRow(room = {}) {
  return `<div class="room-row"><label><span>Room</span><input name="roomName" maxlength="40" value="${escapeHtml(room.name ?? "")}" autocomplete="off"></label><label><span>Area (m²)</span><input name="roomArea" type="number" min="1" max="300" step="0.1" inputmode="decimal" value="${escapeHtml(room.area ?? "")}"></label><label><span>Temperature (°C)</span><input name="roomTarget" type="number" min="5" max="28" step="0.5" inputmode="decimal" value="${escapeHtml(room.target ?? "")}"></label><button type="button" class="remove-button" data-command="house-remove-room" aria-label="Remove room"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>`;
}

function houseForm(house) {
  const field = (name, label, attributes) => `<label><span>${label}</span><input name="${name}" type="number" value="${escapeHtml(house[name] ?? "")}" ${attributes}></label>`;
  const select = (name, label) => `<label><span>${label}</span><select name="${name}">${HOUSE_OPTIONS[name].map(([value, text]) => `<option value="${value}" ${(house[name] || HOUSE_DEFAULTS[name]) === value ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
  const located = Number.isFinite(house.latitude) && Number.isFinite(house.longitude);
  return `<details class="panel credentials" ${Object.keys(house).length ? "" : "open"}><summary><div><h2>Your home</h2><p>Used to tailor energy suggestions. Only the rounded location (about 10 km) leaves this app, to fetch past outdoor temperatures.</p></div><span class="chip">${Object.keys(house).length ? "Edit" : "Add details"}</span></summary>
    <form id="house-settings" class="settings-form house-form">
      <fieldset class="location"><legend>Location</legend>
        <div class="location-row">${field("latitude", "Latitude", 'step="any" min="-90" max="90" inputmode="decimal"')}${field("longitude", "Longitude", 'step="any" min="-180" max="180" inputmode="decimal"')}<button type="button" class="secondary" data-command="house-locate">Use this device's location</button></div>
        <p class="muted">${located ? `Saved as ${escapeHtml(house.latitude)}, ${escapeHtml(house.longitude)}${house.timeZone ? `, ${escapeHtml(house.timeZone)}` : ""}.` : "Rounded to one decimal before saving."}</p>
      </fieldset>
      <div class="form-grid">
        ${field("area", "Heated floor area (m²)", 'min="10" max="2000" step="1"')}
        ${field("occupants", "People living there", 'min="1" max="20" step="1"')}
        ${field("dayTemp", "Comfortable room temperature (°C)", 'min="15" max="25" step="0.5"')}
        ${field("nightTemp", "Night room temperature (°C)", 'min="12" max="25" step="0.5"')}
        ${field("showersPerDay", "Showers or baths per day", 'min="0" max="30" step="1"')}
        ${select("insulation", "Insulation")}
        ${select("emitters", "Heats rooms with")}
        ${select("tariff", "Electricity price")}
        ${select("solar", "Solar")}
        ${select("roomThermostats", "Floor thermostats in rooms")}
        ${select("belowFloor", "Below the heated floor")}
        ${field("floors", "Heated floors", 'min="1" max="5" step="1"')}
        ${field("basementArea", "Heated floor area over the basement (m²)", 'min="0" max="1000" step="1"')}
        ${field("slabInsulation", "Insulation under the heated floor (cm)", 'min="0" max="50" step="1"')}
        ${select("ventilation", "Fresh air comes from")}
      </div>
      <fieldset class="rooms"><legend>Rooms</legend>
        <p class="muted">Each heated room's floor area and the temperature you keep it at. Rooms kept much cooler than the rest affect how the floor loops should be balanced.${house.rooms?.length ? ` Saved rooms add up to ${escapeHtml(formatNumber(house.rooms.reduce((sum, room) => sum + room.area, 0)))} m².` : ""}</p>
        <div class="room-list">${(house.rooms?.length ? house.rooms : [{}]).map(roomRow).join("")}</div>
        <button type="button" class="add-change" data-command="house-add-room">Add room</button>
      </fieldset>
      <button class="primary">Save home details</button>
    </form>
  </details>`;
}

/* ---------- Render and events ---------- */

function render() {
  if (state.loading) return;
  const route = currentRoute();
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.classList.toggle("active", link.dataset.route === route);
    if (link.dataset.route === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const focusKey = document.activeElement?.dataset?.focus;
  const device = activeDevice();
  if (!device && route !== "system") app.innerHTML = waitingForGateway();
  else if (route === "overview") app.innerHTML = overview(device);
  else if (route === "controls") app.innerHTML = controls(device);
  else if (route === "schedule") app.innerHTML = schedule(device);
  else app.innerHTML = system(device);
  if (focusKey) app.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function controlLabel(entry) {
  return `${pointTitle(entry.point)} ${readableLeaf(entry.characteristic, entry.leaf).toLowerCase()}`;
}

function queueWrite(device, entry, value, delay = 0) {
  const key = keyOf(device, entry);
  const existing = state.writes.get(key);
  if (existing?.status === "sending") return;
  clearTimeout(existing?.timer);
  if (delay && value === entry.leaf.value) {
    state.writes.delete(key);
    render();
    return;
  }
  const write = { value, status: "waiting" };
  write.timer = setTimeout(() => commitWrite(device, entry, key, write), delay);
  state.writes.set(key, write);
  render();
}

async function commitWrite(device, entry, key, write) {
  write.status = "sending";
  render();
  try {
    await request("/api/action", { method: "POST", body: JSON.stringify({ source: "cloud", deviceId: device.id, pointId: entry.point.id, characteristic: entry.characteristic.name, path: entry.leaf.path, value: write.value }) });
    // The write already cleared the server cache; keep the confirmed value
    // locally instead of spending another ONECTA request on a refetch.
    entry.leaf.value = write.value;
    const message = isOnOff(entry.leaf) && entry.characteristic.name === "onOffMode"
      ? `${pointTitle(entry.point)} turned ${isOn(write.value) ? "on" : "off"}`
      : `${controlLabel(entry)} set to ${displayValue(entry.leaf, write.value)}`;
    toast(message.charAt(0).toUpperCase() + message.slice(1));
  } catch (error) {
    toast(`${controlLabel(entry)} not changed. ${error.message}`, true);
  } finally {
    if (state.writes.get(key) === write) state.writes.delete(key);
    render();
  }
}

async function withPending(button, task) {
  if (state.pending) return;
  state.pending = true;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    if (!button.classList.contains("toggle") && button.getAttribute("role") !== "radio") button.textContent = "Working…";
  }
  try {
    await task();
  } catch (error) {
    toast(error.message, true);
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  } finally {
    state.pending = false;
  }
}

function writeCurrentSchedule(button, scheduleId, enabled) {
  return withPending(button, async () => {
    await request("/api/schedule", { method: "PUT", body: JSON.stringify({ source: "cloud", deviceId: button.dataset.device, pointId: button.dataset.point, mode: button.dataset.mode, section: "current", value: { scheduleId, enabled } }) });
    state.scheduleDraft = null;
    toast(enabled ? "Schedule on" : "Schedule paused");
    await load(true);
  });
}

app.addEventListener("change", (event) => {
  const picker = event.target.closest("[data-device-picker]");
  if (picker) {
    state.selectedId = picker.value;
    state.scheduleDraft = null;
    render();
    return;
  }
  const choice = event.target.closest("[data-choice-key]");
  if (choice) {
    const found = entryByKey(choice.dataset.choiceKey);
    if (found) queueWrite(found.device, found.entry, found.entry.leaf.values[Number(choice.value)]);
    return;
  }
  if (event.target.closest(".weekly-editor")) {
    captureScheduleDraft();
    render();
  }
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.matches("[data-text-key]")) {
    const found = entryByKey(form.dataset.textKey);
    if (found) queueWrite(found.device, found.entry, String(new FormData(form).get("value")));
    return;
  }
  if (form.matches("#gateway-check")) {
    const button = form.querySelector("button");
    const host = new FormData(form).get("host");
    if (state.pending) return;
    state.pending = true;
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const result = await request("/api/local/probe", { method: "POST", body: JSON.stringify({ host }) });
      state.gatewayCheck = { status: "reachable", host: result.host, model: result.adapterModel, checkedAt: new Date().toISOString() };
      toast("Wi-Fi adapter answered");
      await load();
    } catch {
      state.gatewayCheck = { status: "unreachable", host: String(host || ""), checkedAt: new Date().toISOString() };
      toast("Wi-Fi adapter didn't answer", true);
      render();
    } finally {
      state.pending = false;
    }
    return;
  }
  if (form.matches("#house-settings")) {
    const data = new FormData(form);
    const names = data.getAll("roomName");
    const areas = data.getAll("roomArea");
    const targets = data.getAll("roomTarget");
    for (const key of ["roomName", "roomArea", "roomTarget"]) data.delete(key);
    const house = Object.fromEntries(data);
    house.rooms = names.map((name, index) => ({ name, area: areas[index], target: targets[index] }));
    house.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await withPending(form.querySelector("button:not([type])"), async () => {
      await request("/api/settings", { method: "PUT", body: JSON.stringify({ house }) });
      toast("Home details saved");
      await load();
    });
    return;
  }
  if (!form.matches("#cloud-settings")) return;
  const button = form.querySelector("button");
  const data = new FormData(form);
  await withPending(button, async () => {
    await request("/api/settings", { method: "PUT", body: JSON.stringify({ clientId: data.get("clientId"), clientSecret: data.get("clientSecret") }) });
    toast("Credentials saved");
    await load();
  });
});

app.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]");
  if (action) {
    return withPending(action, async () => {
      await request("/api/action", { method: "POST", body: JSON.stringify({ source: "local", action: action.dataset.action, value: parseValue(action.dataset.value) }) });
      toast("Heat pump updated");
      await load(true);
    });
  }
  const button = event.target.closest("[data-command]");
  const command = button?.dataset.command;
  if (!command) return;
  if (command === "reload") return withPending(button, () => load(true));
  if (command === "toggle" || command === "choose" || command === "step") {
    const found = entryByKey(button.dataset.key);
    if (!found) return;
    const { device, entry } = found;
    const current = shownValue(device, entry);
    if (command === "toggle") return queueWrite(device, entry, flipped(entry.leaf, current));
    if (command === "choose") return queueWrite(device, entry, entry.leaf.values[Number(button.dataset.index)]);
    const step = stepValue(entry.leaf);
    let next = Math.round((Number(current) + Number(button.dataset.dir) * step) / step) * step;
    next = Number(next.toFixed(4));
    if (Number.isFinite(entry.leaf.min)) next = Math.max(entry.leaf.min, next);
    if (Number.isFinite(entry.leaf.max)) next = Math.min(entry.leaf.max, next);
    return queueWrite(device, entry, next, WRITE_DELAY);
  }
  if (command === "set-aside" || command === "bring-back") {
    const current = new Set(state.settings?.setAside || []);
    if (command === "set-aside") current.add(button.dataset.finding);
    else current.delete(button.dataset.finding);
    return withPending(button, async () => {
      state.settings = await request("/api/settings", { method: "PUT", body: JSON.stringify({ setAside: [...current] }) });
      toast(command === "set-aside" ? "Set aside. Find it at the bottom of the list." : "Back on the list");
      await loadEfficiency();
    });
  }
  if (command === "house-add-room") {
    const list = button.closest("form").querySelector(".room-list");
    list.insertAdjacentHTML("beforeend", roomRow());
    list.lastElementChild.querySelector("input").focus();
    return;
  }
  if (command === "house-remove-room") {
    const list = button.closest(".room-list");
    button.closest(".room-row").remove();
    if (!list.children.length) list.insertAdjacentHTML("beforeend", roomRow());
    return;
  }
  if (command === "house-locate") {
    if (!navigator.geolocation) return toast("This browser can't share its location. Enter it by hand.", true);
    navigator.geolocation.getCurrentPosition((position) => {
      const form = button.closest("form");
      // Rounded here too, so precise coordinates never leave the browser.
      form.elements.latitude.value = (Math.round(position.coords.latitude * 10) / 10).toFixed(1);
      form.elements.longitude.value = (Math.round(position.coords.longitude * 10) / 10).toFixed(1);
    }, () => toast("Location wasn't shared. Enter it by hand.", true), { maximumAge: 3_600_000, timeout: 15_000 });
    return;
  }
  if (command === "energy-period") {
    state.energyPeriod = button.dataset.period;
    render();
    return;
  }
  if (command === "cloud-disconnect") return withPending(button, async () => {
    await request("/api/cloud/disconnect", { method: "POST", body: "{}" });
    toast("Daikin account disconnected");
    await load();
  });
  if (command === "schedule-pick") return writeCurrentSchedule(button, button.dataset.schedule, true);
  if (command === "schedule-enable") return writeCurrentSchedule(button, button.dataset.schedule, button.dataset.enabled === "true");
  if (command === "schedule-edit") {
    const device = state.devices.find((item) => item.id === button.dataset.device);
    const point = device?.points.find((item) => item.id === button.dataset.point);
    const modeData = unbox(scheduleModes(point?.schedule)[button.dataset.mode]) || {};
    const definitions = unbox(modeData.schedules) || {};
    const definition = definitions[button.dataset.schedule];
    const dayData = weeklyDefinition(definition);
    if (!dayData) return toast("This programme's format can't be edited here", true);
    state.scheduleDraft = {
      deviceId: button.dataset.device,
      pointId: button.dataset.point,
      mode: button.dataset.mode,
      scheduleId: button.dataset.schedule,
      name: scheduleName(definition, button.dataset.schedule),
      definitions: structuredClone(definitions),
      days: structuredClone(dayData),
    };
    render();
    return;
  }
  if (command === "schedule-cancel") {
    state.scheduleDraft = null;
    render();
    return;
  }
  if (command === "schedule-add") {
    captureScheduleDraft();
    const events = state.scheduleDraft.days[button.dataset.day];
    const last = events.at(-1);
    const lastMinutes = last ? toMinutes(last.time) ?? 360 : 240;
    const at = Math.min(lastMinutes + 120, 23 * 60 + 30);
    events.push({ time: `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`, target: last?.target ?? 20 });
    render();
    app.querySelector(`[data-focus="ed-${button.dataset.day}-${events.length - 1}-time"]`)?.focus();
    return;
  }
  if (command === "schedule-remove") {
    captureScheduleDraft();
    state.scheduleDraft.days[button.dataset.day].splice(Number(button.dataset.index), 1);
    render();
    return;
  }
  if (command === "schedule-copy") {
    captureScheduleDraft();
    const source = state.scheduleDraft.days[button.dataset.day];
    const targets = button.dataset.to === "weekdays" ? weekdays : days;
    for (const day of targets) if (day !== button.dataset.day) state.scheduleDraft.days[day] = structuredClone(source);
    render();
    toast(`${dayLabels[button.dataset.day]} copied to ${button.dataset.to === "weekdays" ? "weekdays" : "every day"}. Save to apply.`);
    return;
  }
  if (command === "schedule-save") {
    captureScheduleDraft();
    const draft = state.scheduleDraft;
    const invalid = days.find((day) => draft.days[day].some((item) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) || !Number.isFinite(item.target)));
    if (invalid) return toast(`Check the times and targets on ${dayLabels[invalid]}`, true);
    const duplicate = days.find((day) => new Set(draft.days[day].map((item) => item.time)).size !== draft.days[day].length);
    if (duplicate) return toast(`${dayLabels[duplicate]} has two changes at the same time`, true);
    for (const day of days) draft.days[day].sort((left, right) => left.time.localeCompare(right.time));
    return withPending(button, async () => {
      await request("/api/schedule", { method: "PUT", body: JSON.stringify({ source: "cloud", deviceId: draft.deviceId, pointId: draft.pointId, mode: draft.mode, section: "schedules", value: rebuildWeeklyDefinitions(draft) }) });
      state.scheduleDraft = null;
      toast(`${draft.name} saved`);
      await load(true);
    });
  }
  if (command === "add-slot") {
    const device = activeDevice();
    const day = button.dataset.day;
    const time = prompt(`Time for ${titleCase(day)} (HH:MM)`, "06:00");
    if (time === null) return;
    const value = prompt("Target temperature (°C)", "20");
    if (value === null) return;
    device.schedules.space[day] ||= [];
    device.schedules.space[day].push({ time, value: Number(value) });
    device.schedules.space[day].sort((a, b) => a.time.localeCompare(b.time));
    render();
  }
  if (command === "save-schedule") return withPending(button, async () => {
    await request("/api/schedule", { method: "PUT", body: JSON.stringify({ source: "local", kind: "space", schedule: activeDevice().schedules.space }) });
    toast("Schedule saved");
    await load(true);
  });
});

function parseValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function relativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} hr ago`;
}

window.addEventListener("hashchange", () => {
  render();
  app.focus({ preventScroll: true });
  window.scrollTo(0, 0);
});
// Coming back to the app after a while shows fresh readings. A plain load
// is served from the server's 8-minute cache, so this costs little quota.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !state.writes.size && Date.now() - state.loadedAt > STALE_AFTER) load();
});
refreshButton.addEventListener("click", () => load(true));
if (new URLSearchParams(location.search).get("connected") === "1") {
  history.replaceState({}, "", `${location.pathname}${location.hash || "#overview"}`);
  setTimeout(() => toast("Daikin account connected"), 300);
}
load();
