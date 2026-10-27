import {
  activeSetpoint, climatePoint, deviceEntries, findEntry, isOn, isReading, pointEntries, pointValue, tankPoint,
} from "./leaves.js";

// The journal is a separate encrypted document holding history: readings
// sampled whenever ONECTA is actually fetched, daily and monthly consumption
// merged from ONECTA's rolling arrays, weather, and a log of setting changes.
// Keys are short because the whole document is written on every update and
// Upstash caps a request at 1 MB.
export const MAX_SAMPLES = 1500;
export const MAX_CHANGES = 500;

export function emptyJournal() {
  return { version: 1, samples: [], daily: {}, monthly: {}, changes: [], weather: null };
}

export function normalizeJournal(value) {
  const journal = { ...emptyJournal(), ...(value && typeof value === "object" ? value : {}) };
  for (const key of ["samples", "changes"]) if (!Array.isArray(journal[key])) journal[key] = [];
  for (const key of ["daily", "monthly"]) if (!journal[key] || typeof journal[key] !== "object") journal[key] = {};
  return journal;
}

// Calendar date in the household's time zone, as YYYY-MM-DD.
export function localDate(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const round1 = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined);

export function sampleFromDevices(devices, time = new Date()) {
  const device = devices?.[0];
  if (!device) return null;
  const climate = climatePoint(device);
  const tank = tankPoint(device);
  const entries = deviceEntries(device);
  const climateEntries = climate ? pointEntries(climate) : [];
  const tankEntries = tank ? pointEntries(tank) : [];
  const sample = {
    t: time.toISOString(),
    o: round1(findEntry(entries, [/outdoortemperature/], isReading)?.leaf.value),
    lw: round1(findEntry(climateEntries.length ? climateEntries : entries, [/leavingwatertemperature/], isReading)?.leaf.value),
    r: round1(findEntry(climateEntries, [/roomtemperature/], isReading)?.leaf.value),
    tk: round1(findEntry(tankEntries, [/tanktemperature/, /domestichotwatertemperature/], isReading)?.leaf.value),
    rt: round1(activeSetpoint(climate, ["roomTemperature"])?.leaf.value),
    off: round1(activeSetpoint(climate, ["leavingWaterOffset"])?.leaf.value),
    tt: round1(activeSetpoint(tank, ["domesticHotWaterTemperature"])?.leaf.value),
    m: pointValue(climate, "operationMode"),
    cs: pointValue(climate, "operationState"),
    ts: pointValue(tank, "operationState"),
    cp: climate ? isOn(pointValue(climate, "onOffMode")) : undefined,
    tp: tank ? isOn(pointValue(tank, "onOffMode")) : undefined,
  };
  return Object.fromEntries(Object.entries(sample).filter(([, value]) => value !== undefined && value !== null));
}

function consumptionCategory(entry) {
  const mode = String(entry.leaf.path || "").split("/").at(-2);
  if (/domestichotwater/i.test(entry.point.type || "")) return "dhw";
  return mode === "cooling" ? "cool" : "heat";
}

function consumptionArrays(devices, period) {
  return (devices || []).flatMap(deviceEntries).filter((entry) =>
    Array.isArray(entry.leaf.value) && new RegExp(`/electrical/[^/]+/${period}$`).test(entry.leaf.path || ""));
}

// ONECTA reports `w` as 14 days (last week Monday..Sunday, then this week)
// and `m` as 24 months (last year January..December, then this year). The
// alignment is from Daikin's API documentation and must be checked against
// the real unit on the first audit.
export function mergeConsumption(journal, devices, today) {
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const lastMonday = addDays(today, -weekday - 7);
  const daily = {};
  for (const entry of consumptionArrays(devices, "w")) {
    const category = consumptionCategory(entry);
    entry.leaf.value.slice(0, 14).forEach((value, index) => {
      if (typeof value !== "number") return;
      const date = addDays(lastMonday, index);
      if (date > today) return;
      daily[date] ||= {};
      daily[date][category] = round1((daily[date][category] || 0) + value);
    });
  }
  Object.assign(journal.daily, daily);

  const year = Number(today.slice(0, 4));
  const thisMonth = today.slice(0, 7);
  const monthly = {};
  for (const entry of consumptionArrays(devices, "m")) {
    const category = consumptionCategory(entry);
    entry.leaf.value.slice(0, 24).forEach((value, index) => {
      if (typeof value !== "number") return;
      const month = `${year - 1 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
      if (month > thisMonth) return;
      monthly[month] ||= {};
      monthly[month][category] = round1((monthly[month][category] || 0) + value);
    });
  }
  Object.assign(journal.monthly, monthly);
  return journal;
}

export function recordSnapshot(journal, devices, { time = new Date(), timeZone } = {}) {
  const sample = sampleFromDevices(devices, time);
  if (sample) {
    journal.samples.push(sample);
    if (journal.samples.length > MAX_SAMPLES) journal.samples.splice(0, journal.samples.length - MAX_SAMPLES);
  }
  mergeConsumption(journal, devices, localDate(time, timeZone));
  return journal;
}

export function recordChange(journal, change, time = new Date()) {
  journal.changes.push({ t: time.toISOString(), ...change });
  if (journal.changes.length > MAX_CHANGES) journal.changes.splice(0, journal.changes.length - MAX_CHANGES);
  return journal;
}
