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
  selectedId: null,
  pending: false,
  scheduleDraft: null,
  gatewayCheck: null,
};
const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const dayLabels = { monday: "Mon", tuesday: "Tue", wednesday: "Wed", thursday: "Thu", friday: "Fri", saturday: "Sat", sunday: "Sun" };

const escapeHtml = (value) => String(value ?? "—").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const titleCase = (value) => String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_/]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
  node.textContent = message;
  toastRegion.append(node);
  setTimeout(() => node.remove(), 4200);
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
    if (!state.devices.some((device) => device.id === state.selectedId)) state.selectedId = state.devices[0]?.id || null;
    state.loading = false;
    updateConnectionPill();
    render();
  } catch (error) {
    state.loading = false;
    app.innerHTML = `<section class="empty-state"><div class="empty-icon">!</div><h1>Controller unavailable</h1><p>${escapeHtml(error.message)}</p><button class="primary" data-command="reload">Try again</button></section>`;
  } finally {
    refreshButton.classList.remove("busy");
  }
}

function updateConnectionPill() {
  const online = state.devices.some((device) => device.online);
  const connected = Boolean(state.settings?.onecta?.connected);
  pill.className = `connection-pill${online ? " online" : connected ? " ready" : ""}`;
  pill.innerHTML = `<i></i>${online ? "Heat pump online" : connected ? "ONECTA connected" : "Connect ONECTA"}`;
}

function currentRoute() {
  const value = location.hash.slice(1) || "overview";
  return ["overview", "controls", "schedule", "system"].includes(value) ? value : "overview";
}

function notices() {
  return state.errors.map((error) => `<div class="notice error"><strong>Could not refresh ${escapeHtml(titleCase(error.source))}.</strong> ${escapeHtml(error.message)}</div>`).join("");
}

function devicePicker(device) {
  if (state.devices.length < 2) return `<span class="source-badge ${device.source}">${device.source === "cloud" ? "Remote" : "Local"}</span>`;
  return `<label class="device-picker"><span>Heat pump</span><select data-device-picker>${state.devices.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === device.id ? "selected" : ""}>${escapeHtml(item.name || item.model || "Daikin")}</option>`).join("")}</select></label>`;
}

function deviceHeader(device, eyebrow, title, subtitle = "") {
  return `<div class="page-head"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="subhead">${escapeHtml(subtitle || device.model || "Daikin heat pump")}</p></div>${devicePicker(device)}</div>`;
}

function waitingForGateway() {
  const connected = Boolean(state.settings?.onecta?.connected);
  if (!connected) return `<section>${notices()}<div class="page-head"><div><p class="eyebrow">Welcome home</p><h1>Your heat pump, beautifully simple.</h1><p class="subhead">Connect your Daikin account once. This dashboard will then adapt to every feature your Altherma exposes.</p></div></div>
    <div class="grid two-col welcome-grid">
      <article class="card dark connect-card"><div><span class="live-tag">Secure connection</span><h2>Connect ONECTA</h2><p>Use the Daikin account that will own the heat pump.</p></div><button class="primary lime-button" data-route-to="system">Set up connection</button></article>
      <article class="card promise-card"><span class="card-icon">⌁</span><h2>One calm control surface</h2><p>Temperatures, modes, hot water and schedules appear automatically after connection.</p></article>
    </div></section>`;

  return `<section>${notices()}<div class="page-head"><div><p class="eyebrow">Connection ready</p><h1>Waiting for your heat pump.</h1><p class="subhead">Your Daikin account is connected. The dashboard will populate as soon as the gateway is released and added to this account.</p></div><span class="source-badge cloud">ONECTA connected</span></div>
    <article class="card waiting-card">
      <div class="waiting-orbit"><span></span></div>
      <div><p class="eyebrow">Current status</p><h2>Gateway not visible yet</h2><p>No setup is needed here. After Daikin releases the old ownership, add the unit to ONECTA and refresh this page.</p>
        <div class="status-steps"><span class="done">✓ App connected</span><span class="active">2 Gateway release pending</span><span>3 Heat pump appears here</span></div>
        <div class="button-row"><button class="primary" data-command="reload">Check again</button><button class="secondary" data-route-to="system">Connection details</button></div>
      </div>
    </article></section>`;
}

function flattenDevice(device) {
  return (device.points || []).flatMap((point) => (point.characteristics || []).flatMap((characteristic) =>
    (characteristic.leaves || []).map((leaf) => ({
      device,
      point,
      characteristic,
      leaf,
      key: `${point.type || ""} ${point.name || ""} ${characteristic.name || ""} ${leaf.path || ""}`.toLowerCase(),
    }))));
}

function findReading(device, patterns, predicate = () => true) {
  const entries = flattenDevice(device);
  for (const pattern of patterns) {
    const found = entries.find((entry) => pattern.test(entry.key) && predicate(entry.leaf.value, entry));
    if (found) return found;
  }
  return null;
}

function pointEntries(point) {
  return (point.characteristics || []).flatMap((characteristic) =>
    (characteristic.leaves || []).map((leaf) => ({ point, characteristic, leaf, key: `${characteristic.name || ""} ${leaf.path || ""}`.toLowerCase() })));
}

function formatValue(value, unit = "") {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return "Available";
  return `${escapeHtml(value)}${unit ? ` <span>${escapeHtml(unit)}</span>` : ""}`;
}

function plainValue(value) {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function semanticStatus(device) {
  const operation = findReading(device, [/operationstate/, /operationmode/]);
  const power = findReading(device, [/onoffmode/]);
  const raw = String(operation?.leaf.value || power?.leaf.value || (device.online ? "Ready" : "Unavailable"));
  return titleCase(raw);
}

function metric(label, entry, note, style = "") {
  return `<article class="card metric-card ${style}"><div class="metric-label"><span>${escapeHtml(label)}</span><span class="metric-dot"></span></div><div class="metric-value">${formatValue(entry?.leaf.value, entry?.leaf.unit)}</div><p class="metric-note">${escapeHtml(note)}</p></article>`;
}

function pointTitle(point) {
  const type = String(point.type || point.name || "");
  if (/domesticHotWater/i.test(type)) return "Hot water";
  if (/climateControl/i.test(type)) return point.name && point.name !== point.type ? point.name : "Indoor climate";
  if (/indoorUnit/i.test(type)) return "Indoor unit";
  if (/outdoorUnit/i.test(type)) return "Outdoor unit";
  return point.name || titleCase(type);
}

function overview(device) {
  if (device.source !== "cloud") return localOverview(device);
  const room = findReading(device, [/roomtemperature/, /indoortemperature/], (value) => typeof value === "number");
  const outdoor = findReading(device, [/outdoortemperature/, /outdoor.*temperature/], (value) => typeof value === "number");
  const leavingWater = findReading(device, [/leavingwatertemperature/, /leavingwater/], (value) => typeof value === "number");
  const tank = findReading(device, [/tanktemperature/, /domestichotwatertemperature/], (value) => typeof value === "number");
  const setpoint = findReading(device, [/roomtemperature/, /setpoint/], (value, entry) => typeof value === "number" && entry.leaf.settable);
  const writable = flattenDevice(device).filter((entry) => entry.leaf.settable).length;
  const visiblePoints = (device.points || []).filter((point) => !/gateway/i.test(point.type || ""));
  return `<section>${notices()}${deviceHeader(device, "Live home", device.name || "Altherma", `${device.model || "Daikin Altherma"} · updated ${relativeTime(device.updatedAt)}`)}
    <div class="grid metric-grid">
      <article class="card dark hero-status"><div class="status-row"><span class="live-tag">● ${device.online ? "Connected" : "Unavailable"}</span><span>Remote</span></div><div><p class="eyebrow light">System state</p><div class="mode-value">${escapeHtml(semanticStatus(device))}</div><p class="metric-note">${writable} available control${writable === 1 ? "" : "s"}</p></div><div class="heat-line"><span></span></div></article>
      ${metric("Room", room, setpoint ? `Target ${plainValue(setpoint.leaf.value)}${setpoint.leaf.unit || "°C"}` : "Indoor sensor")}
      ${metric("Outside", outdoor, "Outdoor sensor")}
      ${metric("Leaving water", leavingWater, "Heating circuit")}
      ${metric("Hot water", tank, "Tank temperature", "lime")}
    </div>
    <div class="section-title"><h2>Your system</h2><button class="text-button" data-route-to="controls">Open controls →</button></div>
    <div class="grid point-overview-grid">${visiblePoints.map(pointOverviewCard).join("") || `<article class="card"><h2>System connected</h2><p class="subhead">No user-facing management points were returned.</p></article>`}</div>
  </section>`;
}

function pointOverviewCard(point) {
  const entries = pointEntries(point);
  const stateEntry = entries.find((entry) => /operationstate|onoffmode/.test(entry.key));
  const temperatures = entries.filter((entry) => typeof entry.leaf.value === "number" && /temperature/.test(entry.key)).slice(0, 2);
  return `<article class="card point-overview"><div class="point-overview-head"><div><p class="eyebrow">${escapeHtml(titleCase(point.type))}</p><h2>${escapeHtml(pointTitle(point))}</h2></div><span class="state-chip">${escapeHtml(titleCase(stateEntry?.leaf.value || "Ready"))}</span></div>
    <div class="mini-readings">${temperatures.map((entry) => `<div><span>${escapeHtml(readableLeaf(entry.characteristic, entry.leaf))}</span><strong>${formatValue(entry.leaf.value, entry.leaf.unit)}</strong></div>`).join("") || `<p class="metric-note">Connected and reporting</p>`}</div>
  </article>`;
}

function localOverview(device) {
  const space = device.controls?.space || {};
  const tank = device.controls?.tank || {};
  return `<section>${deviceHeader(device, "Live home", device.name || "Altherma")}<div class="grid metric-grid">
    <article class="card dark hero-status"><div class="status-row"><span class="live-tag">● ${device.online ? "Connected" : "Unavailable"}</span></div><div><div class="mode-value">${escapeHtml(space.operationMode || "Ready")}</div></div><div class="heat-line"><span></span></div></article>
    ${metric("Room", { leaf: { value: space.indoorTemperature, unit: "°C" } }, `Target ${space.targetTemperature ?? "—"}°C`)}
    ${metric("Outside", { leaf: { value: space.outdoorTemperature, unit: "°C" } }, "Outdoor sensor")}
    ${metric("Hot water", { leaf: { value: tank.temperature, unit: "°C" } }, `Target ${tank.targetTemperature ?? "—"}°C`, "lime")}
  </div></section>`;
}

function readableLeaf(characteristic, leaf) {
  const segments = String(leaf.path || "").split("/").filter(Boolean);
  const path = segments.at(-1);
  const names = {
    onOffMode: "Power",
    operationMode: "Operating mode",
    powerfulMode: "Hot water boost",
  };
  const base = names[path || characteristic.name] || titleCase(path || characteristic.name);
  const modeIndex = segments.indexOf("operationModes");
  const mode = modeIndex >= 0 ? segments[modeIndex + 1] : "";
  return mode ? `${titleCase(mode)} ${base.toLowerCase()}` : base;
}

function controls(device) {
  if (device.source !== "cloud") return localControls(device);
  const controllable = (device.points || []).map((point) => ({
    point,
    writable: pointEntries(point).filter((entry) => entry.leaf.settable),
  })).filter((group) => group.writable.length);
  return `<section>${deviceHeader(device, "Comfort controls", "Make it feel right.", "Only controls supported by this heat pump are shown.")}
    ${controllable.length ? `<div class="control-stack">${controllable.map(({ point, writable }) => cloudPointControls(device, point, writable)).join("")}</div>` : `<article class="card empty-card"><span class="card-icon">⌁</span><h2>No remote controls advertised</h2><p>The heat pump is online, but ONECTA returned readings only.</p></article>`}
    ${readingsDrawer(device)}
  </section>`;
}

function cloudPointControls(device, point, writable) {
  const operation = pointEntries(point).find((entry) => /operationstate/.test(entry.key));
  return `<article class="card control-surface"><div class="control-surface-head"><div><p class="eyebrow">${escapeHtml(titleCase(point.type))}</p><h2>${escapeHtml(pointTitle(point))}</h2><p>${escapeHtml(titleCase(operation?.leaf.value || "Ready"))}</p></div><span class="control-count">${writable.length} control${writable.length === 1 ? "" : "s"}</span></div>
    <div class="control-grid">${writable.map((entry) => cloudControl(device, entry)).join("")}</div>
  </article>`;
}

function cloudData(device, entry) {
  return `data-cloud-action data-device="${escapeHtml(device.id)}" data-point="${escapeHtml(entry.point.id)}" data-characteristic="${escapeHtml(entry.characteristic.name)}" data-path="${escapeHtml(entry.leaf.path || "")}"`;
}

function cloudControl(device, entry) {
  const { characteristic, leaf } = entry;
  const label = readableLeaf(characteristic, leaf);
  const data = cloudData(device, entry);
  if (Array.isArray(leaf.values) && leaf.values.length) {
    return `<div class="control-field"><label>${escapeHtml(label)}<select ${data}>${leaf.values.map((value) => `<option value="${escapeHtml(value)}" ${String(value) === String(leaf.value) ? "selected" : ""}>${escapeHtml(titleCase(value))}</option>`).join("")}</select></label><button class="small-button apply-button" data-command="cloud-write">Apply</button></div>`;
  }
  if (typeof leaf.value === "boolean") {
    return `<div class="switch-field"><div><strong>${escapeHtml(label)}</strong><span>${leaf.value ? "On" : "Off"}</span></div><button class="toggle ${leaf.value ? "on" : ""}" ${data} data-value="${!leaf.value}" data-command="cloud-write" aria-label="Turn ${escapeHtml(label)} ${leaf.value ? "off" : "on"}"></button></div>`;
  }
  if (typeof leaf.value === "number") {
    const step = leaf.step || (leaf.unit === "°C" ? 0.5 : 1);
    return `<div class="setpoint-control"><div><strong>${escapeHtml(label)}</strong><span>${leaf.min !== undefined && leaf.max !== undefined ? `${escapeHtml(leaf.min)}–${escapeHtml(leaf.max)} ${escapeHtml(leaf.unit || "")}` : "Setpoint"}</span></div><div class="setpoint-editor"><input type="number" value="${escapeHtml(leaf.value)}" ${leaf.min !== undefined ? `min="${escapeHtml(leaf.min)}"` : ""} ${leaf.max !== undefined ? `max="${escapeHtml(leaf.max)}"` : ""} step="${escapeHtml(step)}" ${data} aria-label="${escapeHtml(label)}"><span>${escapeHtml(leaf.unit || "")}</span><button class="small-button apply-button" data-command="cloud-write">Set</button></div></div>`;
  }
  if (typeof leaf.value === "string") {
    return `<div class="control-field"><label>${escapeHtml(label)}<input value="${escapeHtml(leaf.value)}" ${data}></label><button class="small-button apply-button" data-command="cloud-write">Apply</button></div>`;
  }
  return "";
}

function readingsDrawer(device) {
  const readOnly = flattenDevice(device).filter((entry) => !entry.leaf.settable && ["string", "number", "boolean"].includes(typeof entry.leaf.value));
  if (!readOnly.length) return "";
  return `<details class="readings-drawer"><summary>All live readings <span>${readOnly.length}</span></summary><div class="readings-grid">${readOnly.map((entry) => `<div><span>${escapeHtml(pointTitle(entry.point))} · ${escapeHtml(readableLeaf(entry.characteristic, entry.leaf))}</span><strong>${formatValue(entry.leaf.value, entry.leaf.unit)}</strong></div>`).join("")}</div></details>`;
}

function localControls(device) {
  const space = device.controls?.space || {};
  const tank = device.controls?.tank || {};
  return `<section>${deviceHeader(device, "Comfort controls", "Make it feel right.")}
    <div class="grid two-col"><article class="card control-surface"><h2>Space heating</h2>${localNumberControl("Room target", "space.targetTemperature", space.targetTemperature, 0.5)}${localNumberControl("Weather curve offset", "space.leavingWaterOffset", space.leavingWaterOffset, 1)}</article>
    <article class="card control-surface"><h2>Hot water</h2>${localNumberControl("Tank target", "tank.targetTemperature", tank.targetTemperature, 1)}</article></div></section>`;
}

function localNumberControl(label, action, value, step) {
  return `<div class="setpoint-control"><div><strong>${escapeHtml(label)}</strong><span>Setpoint</span></div><div class="setpoint-editor"><button class="step-button" data-action="${escapeHtml(action)}" data-value="${Number(value) - step}">−</button><output>${escapeHtml(value)}°</output><button class="step-button" data-action="${escapeHtml(action)}" data-value="${Number(value) + step}">+</button></div></div>`;
}

function schedule(device) {
  if (device.source !== "cloud") return localSchedule(device);
  const points = (device.points || []).filter((point) => point.schedule);
  return `<section>${deviceHeader(device, "Weekly rhythm", "Schedules", "Choose when your home should be comfortable.")}
    ${points.length ? `<div class="schedule-stack">${points.map((point) => cloudScheduleCard(device, point)).join("")}</div>` : `<article class="card empty-card"><span class="card-icon">□</span><h2>No cloud schedule available</h2><p>This heat pump did not advertise schedules through ONECTA.</p></article>`}
  </section>`;
}

function scheduleModes(schedule) {
  const value = unbox(schedule?.value) || {};
  return unbox(value.modes) || {};
}

function cloudScheduleCard(device, point) {
  const scheduleData = point.schedule;
  const modes = scheduleModes(scheduleData);
  return `<article class="card schedule-card"><div class="schedule-card-head"><div><p class="eyebrow">${escapeHtml(titleCase(point.type))}</p><h2>${escapeHtml(pointTitle(point))}</h2></div><span class="state-chip">${scheduleData.settable ? "Editable" : "Read only"}</span></div>
    ${Object.entries(modes).map(([mode, data]) => scheduleMode(device, point, mode, unbox(data) || {}, scheduleData.settable)).join("") || `<p class="subhead">No schedule modes were returned.</p>`}
  </article>`;
}

function scheduleMode(device, point, mode, data, settable) {
  const currentNode = data.currentSchedule || {};
  const current = String(unbox(currentNode) ?? "0");
  const definitions = unbox(data.schedules) || {};
  const choices = currentNode.values || Object.keys(definitions);
  const enabled = Boolean(unbox(data.enabled));
  const activeDefinition = definitions[current] || {};
  const editable = weeklyDefinition(activeDefinition);
  const draft = state.scheduleDraft?.deviceId === device.id && state.scheduleDraft?.pointId === point.id && state.scheduleDraft?.mode === mode && state.scheduleDraft?.scheduleId === current ? state.scheduleDraft : null;
  return `<div class="schedule-mode"><div class="schedule-mode-toolbar"><div><strong>${escapeHtml(titleCase(mode))}</strong><span>${enabled ? "Following schedule" : "Schedule paused"}</span></div>
    ${settable ? `<div class="schedule-actions"><select data-schedule-id aria-label="${escapeHtml(titleCase(mode))} programme">${(choices.length ? choices : [current]).map((id) => `<option value="${escapeHtml(id)}" ${String(id) === current ? "selected" : ""}>${escapeHtml(scheduleName(definitions[id], id))}</option>`).join("")}</select><label class="check-control"><input type="checkbox" data-schedule-enabled ${enabled ? "checked" : ""}> Active</label><button class="small-button" data-command="cloud-schedule-current" data-device="${escapeHtml(device.id)}" data-point="${escapeHtml(point.id)}" data-mode="${escapeHtml(mode)}">Apply</button>${editable && !draft ? `<button class="small-button" data-command="schedule-edit" data-device="${escapeHtml(device.id)}" data-point="${escapeHtml(point.id)}" data-mode="${escapeHtml(mode)}" data-schedule="${escapeHtml(current)}">Edit programme</button>` : ""}</div>` : ""}</div>
    ${draft ? weeklyEditor(draft) : weeklyPreview(activeDefinition)}
  </div>`;
}

function scheduleName(definition, fallback) {
  const name = unbox(definition?.name);
  return name ? String(name) : `Programme ${fallback}`;
}

function weeklyPreview(definition) {
  const value = unbox(definition) || {};
  if (!days.some((day) => Object.hasOwn(value, day))) return `<p class="metric-note schedule-empty">The active programme has no day-by-day preview.</p>`;
  const rows = days.map((day) => {
    const events = unbox(value[day]) || [];
    return `<div class="day-row"><span class="day-name">${dayLabels[day]}</span><div class="slots">${events.length ? events.map((event) => {
      const item = unbox(event) || {};
      const time = unbox(item.time ?? item.startTime ?? item.StartTime) ?? "—";
      const target = unbox(item.value ?? item.temperature ?? item.targetTemperature ?? item.TargetTemperature);
      return `<span class="slot">${escapeHtml(formatTime(time))}${target !== undefined ? ` <b>${escapeHtml(target)}°</b>` : ""}</span>`;
    }).join("") : `<span class="metric-note">No changes</span>`}</div></div>`;
  }).join("");
  return `<div class="schedule-grid">${rows}</div>`;
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
      result[day].push({ time: String(unbox(event[timeKey])), target: Number(unbox(event[targetKey])) });
    }
  }
  return result;
}

function weeklyEditor(draft) {
  return `<div class="weekly-editor"><div class="editor-intro"><div><strong>Edit ${escapeHtml(draft.name)}</strong><span>Set each change, then save the complete programme.</span></div><button class="text-button" data-command="schedule-cancel">Cancel</button></div>
    <div class="schedule-editor-days">${days.map((day) => `<section class="editor-day" data-editor-day="${day}"><div class="editor-day-head"><span class="day-name">${dayLabels[day]}</span><button class="small-button" data-command="schedule-add" data-day="${day}">+ Add change</button></div><div class="editor-events">${draft.days[day].map((event, index) => scheduleEventRow(day, index, event)).join("") || `<span class="metric-note no-events">No changes</span>`}</div></section>`).join("")}</div>
    <div class="editor-footer"><button class="primary" data-command="schedule-save">Save programme</button><span>Changes are sent to your heat pump only when you save.</span></div>
  </div>`;
}

function scheduleEventRow(day, index, event) {
  return `<div class="editor-event" data-event-index="${index}"><label>Time<input type="time" data-event-time value="${escapeHtml(formatTime(event.time))}"></label><label>Target<input type="number" data-event-target value="${escapeHtml(event.target)}" step="0.5"><span>°C</span></label><button class="remove-button" data-command="schedule-remove" data-day="${day}" data-index="${index}" aria-label="Remove ${dayLabels[day]} change">×</button></div>`;
}

function captureScheduleDraft(container) {
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

function formatTime(value) {
  const text = String(value);
  return /^\d{4}$/.test(text) ? `${text.slice(0, 2)}:${text.slice(2)}` : text;
}

function localSchedule(device) {
  const scheduleData = device.schedules?.space || {};
  return `<section>${deviceHeader(device, "Weekly rhythm", "Schedules")}<article class="card"><div class="schedule-grid">${days.map((day) => `<div class="day-row"><span class="day-name">${dayLabels[day]}</span><div class="slots">${(scheduleData[day] || []).map((slot) => `<span class="slot">${escapeHtml(slot.time)} <b>${escapeHtml(slot.value)}°</b></span>`).join("") || `<span class="metric-note">No changes</span>`}</div><button class="small-button" data-command="add-slot" data-day="${day}">+</button></div>`).join("")}</div><div class="divider"></div><button class="primary" data-command="save-schedule">Save schedule</button></article></section>`;
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
  const remainingDay = state.rateLimit.remainingDay;
  const limitDay = state.rateLimit.limitDay;
  const accountState = cloud.connected ? (state.devices.length ? "Heat pump connected" : "Connected · waiting for gateway") : cloud.configured ? "Ready to authorize" : "Not configured";
  const gatewayCard = localReachability ? `<article class="card gateway-card"><div class="gateway-card-head"><div><p class="eyebrow">Home network</p><h2>Wi-Fi gateway</h2><p class="subhead">Check whether the adapter responds from this Mac.</p></div><span class="reachability ${gateway.status}"><i></i>${gateway.status === "reachable" ? "Reachable" : gateway.status === "unreachable" ? "Not reachable" : "Not checked"}</span></div>
      <form id="gateway-check" class="gateway-form"><label>Gateway IP address<input name="host" required inputmode="decimal" placeholder="192.168.1.42" value="${escapeHtml(gateway.host || "")}" autocomplete="off"></label><button class="primary">Check reachability</button></form>
      <div class="gateway-result">${gateway.status === "reachable" ? `<strong>${escapeHtml(gateway.model || "Daikin Wi-Fi gateway")}</strong><span>${gateway.checkedAt ? `Checked ${escapeHtml(relativeTime(gateway.checkedAt))}` : "Responding on your home network"}</span>` : gateway.status === "unreachable" ? `<strong>No response</strong><span>Check the IP and confirm this Mac is connected to your home Wi-Fi.</span>` : `<span>This read-only check does not change heat-pump settings.</span>`}</div>
    </article>` : `<article class="card gateway-card"><div class="gateway-card-head"><div><p class="eyebrow">Home network</p><h2>Wi-Fi gateway</h2><p class="subhead">Local reachability is available from the Mac dashboard while you are at home.</p></div><span class="reachability local-only"><i></i>Local only</span></div>
      <div class="gateway-result"><strong>Remote control stays available</strong><span>This hosted dashboard uses ONECTA and does not expose your home network or Wi-Fi adapter.</span></div>
    </article>`;
  return `<section>${device ? deviceHeader(device, "Account & connection", "System", "Connection health and access settings.") : `<div class="page-head"><div><p class="eyebrow">Account & connection</p><h1>System</h1><p class="subhead">Connection health and access settings.</p></div></div>`}${notices()}
    <div class="grid system-grid">
      <article class="card connection-card"><div class="connection-state"><span class="big-status ${cloud.connected ? "ok" : ""}"></span><div><p class="eyebrow">Daikin account</p><h2>${escapeHtml(accountState)}</h2></div></div>
        <div class="diagnostic-list">${infoRow("Authorization", cloud.connected ? "Active" : "Not connected")}${infoRow("Gateway devices", state.devices.filter((item) => item.source === "cloud").length)}${remainingDay !== null && remainingDay !== undefined ? infoRow("API requests today", `${remainingDay} of ${limitDay ?? "—"} remaining`) : ""}</div>
        <div class="button-row">${cloud.configured ? `<a class="primary" href="/api/cloud/connect">${cloud.connected ? "Reconnect account" : "Connect account"}</a>` : ""}<button class="secondary" data-command="reload">Refresh status</button></div>
      </article>
      <details class="card credentials-card" ${cloud.configured ? "" : "open"}><summary><div><p class="eyebrow">Developer access</p><h2>ONECTA credentials</h2><p class="subhead">Saved only on this controller.</p></div><span>${cloud.configured ? "Edit" : "Set up"}</span></summary>
        <div class="credentials-body"><form id="cloud-settings" class="settings-form"><label>Client ID<input name="clientId" value="${escapeHtml(cloud.clientId || "")}" autocomplete="off"></label><label>Client secret<input type="password" name="clientSecret" placeholder="${cloud.hasClientSecret ? "Saved — leave blank to keep" : "Required"}" autocomplete="new-password"></label><label>Redirect URI<input readonly value="${escapeHtml(cloud.redirectUri || "")}"></label><button class="primary">Save credentials</button></form></div>
      </details>
    </div>
    ${gatewayCard}
    ${cloud.connected ? `<details class="danger-zone"><summary>Connection options</summary><div><p>Disconnecting removes the saved Daikin session from this controller. It does not remove the heat pump from your Daikin account.</p><button class="danger" data-command="cloud-disconnect">Disconnect Daikin account</button></div></details>` : ""}
  </section>`;
}

function infoRow(label, value) {
  return `<div class="diagnostic"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function render() {
  if (state.loading) return;
  const route = currentRoute();
  document.querySelectorAll("[data-route]").forEach((link) => link.classList.toggle("active", link.dataset.route === route));
  const device = activeDevice();
  if (!device && route !== "system") app.innerHTML = waitingForGateway();
  else if (route === "overview") app.innerHTML = overview(device);
  else if (route === "controls") app.innerHTML = controls(device);
  else if (route === "schedule") app.innerHTML = schedule(device);
  else app.innerHTML = system(device);
}

async function withPending(button, task) {
  if (state.pending) return;
  state.pending = true;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    if (!button.classList.contains("toggle")) button.textContent = "Working…";
  }
  try {
    await task();
  } catch (error) {
    toast(error.message, true);
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  } finally {
    state.pending = false;
  }
}

app.addEventListener("change", (event) => {
  const picker = event.target.closest("[data-device-picker]");
  if (picker) {
    state.selectedId = picker.value;
    render();
  }
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.matches("#gateway-check")) {
    const form = event.target;
    const button = form.querySelector("button");
    const host = new FormData(form).get("host");
    if (state.pending) return;
    state.pending = true;
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const result = await request("/api/local/probe", { method: "POST", body: JSON.stringify({ host }) });
      state.gatewayCheck = { status: "reachable", host: result.host, model: result.adapterModel, checkedAt: new Date().toISOString() };
      toast("Wi-Fi gateway is reachable");
      await load();
    } catch {
      state.gatewayCheck = { status: "unreachable", host: String(host || ""), checkedAt: new Date().toISOString() };
      toast("Wi-Fi gateway did not respond", true);
      render();
    } finally {
      state.pending = false;
    }
    return;
  }
  if (!event.target.matches("#cloud-settings")) return;
  const form = event.target;
  const button = form.querySelector("button");
  const data = new FormData(form);
  await withPending(button, async () => {
    await request("/api/settings", { method: "PUT", body: JSON.stringify({ clientId: data.get("clientId"), clientSecret: data.get("clientSecret") }) });
    toast("Credentials saved");
    await load();
  });
});

app.addEventListener("click", async (event) => {
  const routeLink = event.target.closest("[data-route-to]");
  if (routeLink) {
    location.hash = routeLink.dataset.routeTo;
    return;
  }
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
  if (command === "cloud-disconnect") return withPending(button, async () => {
    await request("/api/cloud/disconnect", { method: "POST", body: "{}" });
    toast("Daikin account disconnected");
    await load();
  });
  if (command === "cloud-write") {
    const root = button.closest(".control-field, .setpoint-control")?.querySelector("[data-cloud-action]") || button.closest("[data-cloud-action]");
    if (!root) return;
    const raw = root.matches("input,select") ? root.value : root.dataset.value;
    return withPending(button, async () => {
      await request("/api/action", { method: "POST", body: JSON.stringify({ source: "cloud", deviceId: root.dataset.device, pointId: root.dataset.point, characteristic: root.dataset.characteristic, path: root.dataset.path, value: parseValue(raw) }) });
      toast(`${readableControl(root)} updated`);
      await load(true);
    });
  }
  if (command === "cloud-schedule-current") {
    const mode = button.closest(".schedule-mode");
    const scheduleId = mode.querySelector("[data-schedule-id]").value;
    const enabled = mode.querySelector("[data-schedule-enabled]").checked;
    return withPending(button, async () => {
      await request("/api/schedule", { method: "PUT", body: JSON.stringify({ source: "cloud", deviceId: button.dataset.device, pointId: button.dataset.point, mode: button.dataset.mode, section: "current", value: { scheduleId, enabled } }) });
      state.scheduleDraft = null;
      toast("Schedule updated");
      await load(true);
    });
  }
  if (command === "schedule-edit") {
    const device = state.devices.find((item) => item.id === button.dataset.device);
    const point = device?.points.find((item) => item.id === button.dataset.point);
    const modeData = unbox(scheduleModes(point?.schedule)[button.dataset.mode]) || {};
    const definitions = unbox(modeData.schedules) || {};
    const definition = definitions[button.dataset.schedule];
    const dayData = weeklyDefinition(definition);
    if (!dayData) return toast("This programme format cannot be edited safely", true);
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
    captureScheduleDraft(button.closest(".weekly-editor"));
    state.scheduleDraft.days[button.dataset.day].push({ time: "06:00", target: 20 });
    render();
    return;
  }
  if (command === "schedule-remove") {
    captureScheduleDraft(button.closest(".weekly-editor"));
    state.scheduleDraft.days[button.dataset.day].splice(Number(button.dataset.index), 1);
    render();
    return;
  }
  if (command === "schedule-save") {
    captureScheduleDraft(button.closest(".weekly-editor"));
    const draft = state.scheduleDraft;
    const invalid = days.some((day) => draft.days[day].some((item) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) || !Number.isFinite(item.target)));
    if (invalid) return toast("Check every schedule time and temperature", true);
    for (const day of days) draft.days[day].sort((left, right) => left.time.localeCompare(right.time));
    return withPending(button, async () => {
      await request("/api/schedule", { method: "PUT", body: JSON.stringify({ source: "cloud", deviceId: draft.deviceId, pointId: draft.pointId, mode: draft.mode, section: "schedules", value: rebuildWeeklyDefinitions(draft) }) });
      state.scheduleDraft = null;
      toast("Programme saved");
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

function readableControl(element) {
  return element.closest(".control-field, .setpoint-control, .switch-field")?.querySelector("label,strong")?.textContent?.trim() || "Control";
}

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

window.addEventListener("hashchange", render);
refreshButton.addEventListener("click", () => load(true));
if (new URLSearchParams(location.search).get("connected") === "1") {
  history.replaceState({}, "", `${location.pathname}${location.hash || "#overview"}`);
  setTimeout(() => toast("Daikin account connected"), 300);
}
load();
