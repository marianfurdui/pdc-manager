import { daysInMonth, monthlyDegreeDays } from "./degree-days.js";
import { addDays, localDate } from "./journal.js";
import {
  activeSetpoint, climatePoint, deviceEntries, isOn, pointEntries, pointValue, tankPoint,
} from "./leaves.js";

// Energy-saving rules for a Daikin Altherma, read-only. Each rule looks for
// the data it needs and returns nothing when the unit or the journal does
// not provide it. Thresholds assume the household profile unless noted, and
// are documented with their reasoning in docs/EFFICIENCY_PLAYBOOK.md.
export const THRESHOLDS = {
  roomTarget: 21.5,
  savingPerRoomDegree: 0.06,
  savingPerWaterDegree: 0.025,
  setbackMax: { underfloor: 1, radiators: 2, mixed: 1, fancoil: 2 },
  tankTarget: 50,
  tankSuggested: 48,
  // Highest sensible leaving water at +15 °C and -10 °C outside.
  curve: { underfloor: [[15, 25], [-10, 35]], mixed: [[15, 27], [-10, 42]], radiators: [[15, 30], [-10, 50]], fancoil: [[15, 30], [-10, 45]] },
  curveMargin: 3,
  overshoot: 0.7,
  minSamples: 10,
  summerMean: 16,
  heatingSeasonMean: 15,
  dhwShare: 0.35,
  trendChange: 0.1,
  minMonthHdd: 30,
  // Rough electricity use for heating plus hot water, kWh per m² per year.
  benchmark: { new: 25, renovated: 40, average: 55, poor: 80 },
};

// Installer settings ONECTA does not expose; read from the indoor unit.
export const INSTALLER_CHECKLIST = [
  "Weather-dependent curve: leaving-water temperature at the low and high outdoor points",
  "Space heating OFF temperature (outdoor temperature above which heating stops)",
  "Backup heater: enabled steps, balance/bivalent temperature, and whether it may help hot water",
  "Legionella disinfection: day, time, target temperature and how often",
  "Control method: leaving-water, external room thermostat, or the unit's room thermostat",
  "Water pump mode: continuous, sampling or on demand",
  "Hot water: reheat mode, hysteresis and maximum temperature",
  "Room thermostats: which rooms, their current setpoints, and whether they open and close actuators on the floor manifold",
  "Manifold: any bypass valve, buffer tank or separate circulation pump",
];

const SEVERITY_ORDER = { warn: 0, suggest: 1, info: 2 };
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const fmt = (value, digits = 1) => Number(value).toFixed(digits).replace(/\.0$/, "");
const percent = (value) => `about ${Math.max(1, Math.round(value * 100))}%`;

function finding(id, severity, title, evidence, suggestion, extra = {}) {
  return { id, severity, title, evidence, suggestion, ...extra };
}

/* ---------- Schedules ---------- */

const unbox = (value) => (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value") && Object.keys(value).every((key) => ["value", "settable", "values", "unit", "minValue", "maxValue", "stepValue", "ref"].includes(key)) ? value.value : value);
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function toMinutes(time) {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(String(time));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// Accepts day arrays ({ monday: [{ time, value }] }) and day maps keyed by
// start time ({ actions: { monday: { "0700": { roomTemperature: 20 } } } }).
function dayEvents(node) {
  const value = unbox(node);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const event = unbox(item) || {};
      return { minutes: toMinutes(unbox(event.time ?? event.startTime ?? event.StartTime)), target: unbox(event.value ?? event.temperature ?? event.targetTemperature ?? event.TargetTemperature) };
    });
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([time, action]) => {
      const inner = unbox(action);
      const target = inner && typeof inner === "object" ? Object.values(inner).map(unbox).find((item) => item !== undefined) : inner;
      return { minutes: toMinutes(time), target };
    });
  }
  return [];
}

export function activeSchedule(point, mode) {
  const modes = unbox(unbox(point?.schedule?.value)?.modes) || {};
  const entry = unbox(modes[mode]) || unbox(Object.values(modes)[0]);
  if (!entry) return null;
  const current = String(unbox(entry.currentSchedule) ?? "");
  const definition = unbox((unbox(entry.schedules) || {})[current]) || {};
  const days = unbox(definition.actions) || definition;
  if (!DAYS.some((day) => Object.hasOwn(days, day))) return null;
  return {
    enabled: Boolean(unbox(entry.enabled)),
    name: unbox(definition.name) || `Programme ${current}`,
    week: Object.fromEntries(DAYS.map((day) => [day, dayEvents(days[day]).filter((event) => event.minutes !== null).sort((x, y) => x.minutes - y.minutes)])),
  };
}

/* ---------- Context ---------- */

function recentMeanOutdoor(journal, today) {
  const daily = journal?.weather?.daily || {};
  const week = Array.from({ length: 7 }, (_, index) => daily[addDays(today, -1 - index)]).filter(Number.isFinite);
  if (week.length >= 4) return week.reduce((a, b) => a + b, 0) / week.length;
  const cutoff = `${addDays(today, -7)}T00:00`;
  const samples = (journal?.samples || []).filter((sample) => sample.t >= cutoff && Number.isFinite(sample.o)).map((sample) => sample.o);
  return samples.length >= 4 ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
}

function heatingSamples(journal) {
  return (journal?.samples || []).filter((sample) => sample.cp !== false && /heating/i.test(sample.cs || "") && !/heating/i.test(sample.ts || ""));
}

function expectedMaxWater(outdoor, emitters) {
  const [[warmOut, warmWater], [coldOut, coldWater]] = THRESHOLDS.curve[emitters] || THRESHOLDS.curve.underfloor;
  const clamped = Math.min(warmOut, Math.max(coldOut, outdoor));
  return coldWater + ((clamped - coldOut) * (warmWater - coldWater)) / (warmOut - coldOut);
}

export function monthlyStats(journal) {
  const hdd = monthlyDegreeDays(journal?.weather?.daily || {});
  const months = new Set([...Object.keys(journal?.monthly || {}), ...Object.keys(hdd)]);
  return [...months].sort().map((month) => {
    const kwh = journal?.monthly?.[month] || {};
    const weather = hdd[month];
    const complete = Boolean(weather && weather.days >= daysInMonth(month) * 0.9);
    return {
      month,
      heat: kwh.heat ?? null,
      dhw: kwh.dhw ?? null,
      cool: kwh.cool ?? null,
      hdd: weather ? weather.hdd : null,
      meanOutdoor: weather ? weather.mean : null,
      complete,
      kwhPerHdd: complete && kwh.heat != null && weather.hdd >= THRESHOLDS.minMonthHdd ? Math.round((kwh.heat / weather.hdd) * 1000) / 1000 : null,
    };
  });
}

/* ---------- Rules ---------- */

const rules = [
  function activeFaults({ device }) {
    return deviceEntries(device)
      .filter((entry) => entry.leaf.value === true && /isinerrorstate|isinemergencystate|isinwarningstate|isincautionstate/.test(entry.key))
      .map((entry) => {
        const code = pointEntries(entry.point).find((item) => /errorcode/.test(item.key) && item.leaf.value && item.leaf.value !== "-")?.leaf.value;
        return finding(`fault-${entry.point.id}`, "warn", "The unit reports a fault or warning",
          `${entry.point.name || entry.point.type} flags ${entry.characteristic.name}${code ? ` with code ${code}` : ""}.`,
          "Faults often force the backup heater or stop the compressor. Check the indoor unit display and contact the installer if it persists.");
      });
  },

  function backupHeater({ device }) {
    const active = deviceEntries(device).filter((entry) => /backupheater|boosterheater/.test(entry.key) && !entry.leaf.settable
      && (entry.leaf.value === true || entry.leaf.value === "on" || (typeof entry.leaf.value === "number" && entry.leaf.value > 0 && !/temperature/.test(entry.key))));
    if (!active.length) return [];
    return [finding("backup-heater", "warn", "The electric backup heater is running",
      active.map((entry) => `${entry.characteristic.name}${entry.leaf.path || ""} = ${entry.leaf.value}`).join("; "),
      "The backup heater turns 1 kWh of electricity into 1 kWh of heat, versus 3–4 kWh from the compressor. Check the balance temperature and whether it is allowed to help hot water.")];
  },

  function roomTarget({ device, house }) {
    const climate = climatePoint(device);
    if (/cool/i.test(String(pointValue(climate, "operationMode") || ""))) return [];
    const setpoint = activeSetpoint(climate, ["roomTemperature"]);
    if (!setpoint) return [];
    const preferred = Number.isFinite(house?.dayTemp) ? house.dayTemp : THRESHOLDS.roomTarget;
    const excess = setpoint.leaf.value - preferred;
    if (excess <= 0.01) return [];
    return [finding("room-target", "suggest", "Room target is above your preferred temperature",
      `Heating target is ${fmt(setpoint.leaf.value)}°C; ${Number.isFinite(house?.dayTemp) ? "your profile says" : "a common comfortable level is"} ${fmt(preferred)}°C.`,
      `Lower it 0.5°C at a time and give the floor two days to settle before judging comfort.`,
      { estimate: `${percent(excess * THRESHOLDS.savingPerRoomDegree)} less heating energy`, control: "controls" })];
  },

  function waterOffset({ device }) {
    const offset = activeSetpoint(climatePoint(device), ["leavingWaterOffset"]);
    if (!offset || offset.leaf.value <= 0) return [];
    return [finding("water-offset", "suggest", "The weather curve is shifted upwards",
      `Leaving-water offset is +${fmt(offset.leaf.value)}°C, so the water is warmer than the curve asks for at every outdoor temperature.`,
      "Step the offset down by 1°C, wait 3–4 days, and keep going while rooms stay comfortable.",
      { estimate: `${percent(offset.leaf.value * THRESHOLDS.savingPerWaterDegree)} better efficiency`, control: "controls" })];
  },

  function roomsOvershoot({ journal }) {
    const gaps = heatingSamples(journal).filter((sample) => Number.isFinite(sample.r) && Number.isFinite(sample.rt)).map((sample) => sample.r - sample.rt);
    if (gaps.length < THRESHOLDS.minSamples) return [];
    const typical = median(gaps);
    if (typical <= THRESHOLDS.overshoot) return [];
    return [finding("rooms-overshoot", "suggest", "Rooms stay warmer than the target",
      `While heating, the room is typically ${fmt(typical)}°C above target (${gaps.length} readings).`,
      "The water is hotter than the house needs. Lowering the leaving-water offset (or the curve) by 1°C lets the heat pump run cooler for the same comfort.",
      { estimate: `${percent(THRESHOLDS.savingPerWaterDegree)} better efficiency per °C of water`, control: "controls" })];
  },

  function waterTooHot({ journal, emitters }) {
    const excess = heatingSamples(journal).filter((sample) => Number.isFinite(sample.o) && Number.isFinite(sample.lw))
      .map((sample) => sample.lw - expectedMaxWater(sample.o, emitters));
    if (excess.length < THRESHOLDS.minSamples) return [];
    const typical = median(excess);
    if (typical <= THRESHOLDS.curveMargin) return [];
    return [finding("water-too-hot", "suggest", "Heating water is hotter than this system should need",
      `Leaving water is typically ${fmt(typical)}°C above the usual maximum for ${emitters} heating at the same outdoor temperature (${excess.length} readings).`,
      "Ask for (or read) the weather-curve points on the indoor unit. Lowering the curve is usually the single biggest efficiency gain for floor heating.",
      { estimate: `${percent(typical * THRESHOLDS.savingPerWaterDegree)} better efficiency` })];
  },

  function deepSetback({ device, emitters }) {
    const climate = climatePoint(device);
    const mode = String(pointValue(climate, "operationMode") || "heating");
    const schedule = activeSchedule(climate, /cool/i.test(mode) ? "cooling" : "heating");
    if (!schedule?.enabled) return [];
    const targets = Object.values(schedule.week).flat().map((event) => event.target).filter((target) => typeof target === "number" && target <= 30);
    if (targets.length < 2) return [];
    const depth = Math.max(...targets) - Math.min(...targets);
    const limit = THRESHOLDS.setbackMax[emitters] ?? 1;
    if (depth <= limit) return [];
    return [finding("deep-setback", "suggest", "The schedule drops the temperature further than this system recovers from efficiently",
      `${schedule.name} swings between ${fmt(Math.min(...targets))}°C and ${fmt(Math.max(...targets))}°C (${fmt(depth)}°C).`,
      emitters === "underfloor"
        ? "A slab takes hours to reheat, so the heat pump then runs hot and hard each morning. Keep setbacks to about 1°C, or run a steady target."
        : `Keep setbacks to about ${limit}°C so recovery doesn't need hot water or the backup heater.`,
      { control: "schedule" })];
  },

  function roomThermostats({ house, emitters, device }) {
    if (!["some", "all"].includes(house?.roomThermostats) || !["underfloor", "mixed"].includes(emitters)) return [];
    const target = activeSetpoint(climatePoint(device), ["roomTemperature"])?.leaf.value;
    const above = Number.isFinite(target) ? `${fmt(target + 1)}–${fmt(target + 2)}°C` : "1–2°C above the temperature you want";
    return [finding("room-thermostats", "info", "Room thermostats can work against the weather curve",
      `Your profile says ${house.roomThermostats === "all" ? "every room has" : "some rooms have"} a floor thermostat. When they close loops, less water flows, the heat pump needs hotter water for the remaining rooms and starts and stops more often.`,
      `Set the room thermostats to ${above}, so loops stay open and the weather curve does the regulating. Close loops only in rooms you deliberately keep cooler, and keep at least the largest rooms always open.`,
      { estimate: "often a few % from steadier running and lower water temperature" })];
  },

  function tankTarget({ device, house }) {
    const setpoint = activeSetpoint(tankPoint(device), ["domesticHotWaterTemperature"]);
    if (!setpoint || setpoint.leaf.value <= THRESHOLDS.tankTarget) return [];
    const suggested = (house?.occupants || 0) >= 5 ? THRESHOLDS.tankTarget : THRESHOLDS.tankSuggested;
    return [finding("tank-target", "suggest", "Hot water is stored hotter than usually needed",
      `Tank target is ${fmt(setpoint.leaf.value)}°C.`,
      `Try ${suggested}°C. Weekly disinfection still protects against legionella, and each degree lower raises hot-water efficiency.`,
      { estimate: `${percent((setpoint.leaf.value - suggested) * 0.02)} less hot-water energy`, control: "controls" })];
  },

  function boostLeftOn({ device }) {
    const tank = tankPoint(device);
    if (!tank || !isOn(pointValue(tank, "powerfulMode"))) return [];
    return [finding("boost-on", "info", "Hot water boost is on",
      "Powerful mode heats the tank as fast as possible, which can bring in the backup or booster heater.",
      "Use it only when you need extra hot water soon. It switches off by itself after one heat-up.", { control: "controls" })];
  },

  function nightHotWater({ device, house }) {
    if (house?.tariff && house.tariff !== "flat") return [];
    const tank = tankPoint(device);
    const schedule = activeSchedule(tank, "heating");
    if (!schedule?.enabled) return [];
    const night = Object.entries(schedule.week).flatMap(([day, events]) => events
      .filter((event) => event.minutes < 360 && ((typeof event.target === "number" && event.target >= 40) || /comfort|on|heat|reheat/i.test(String(event.target))))
      .map((event) => `${day.slice(0, 3)} ${String(Math.floor(event.minutes / 60)).padStart(2, "0")}:${String(event.minutes % 60).padStart(2, "0")}`));
    if (!night.length) return [];
    return [finding("night-hot-water", "suggest", "Hot water heats in the coldest hours",
      `The hot-water schedule heats at ${night.slice(0, 4).join(", ")}${night.length > 4 ? "…" : ""}. On a flat tariff night electricity costs the same.`,
      "Move the main reheat to early afternoon (13:00–16:00), when outdoor air is warmest and the heat pump is most efficient.",
      { estimate: "typically 5–15% less hot-water energy in winter", control: "schedule" })];
  },

  function modeForSeason({ device, recentMean, today }) {
    const mode = String(pointValue(climatePoint(device), "operationMode") || "");
    if (!mode) return [];
    const month = Number(today.slice(5, 7));
    const heatingSeason = recentMean !== null ? recentMean < THRESHOLDS.heatingSeasonMean : month >= 10 || month <= 4;
    if (!heatingSeason) return [];
    if (/cool/i.test(mode)) {
      return [finding("cooling-in-winter", "warn", "Cooling mode is selected in the heating season",
        recentMean !== null ? `Outdoor mean over the last week is ${fmt(recentMean)}°C.` : "It is the heating season.",
        "Switch the mode to heating.", { control: "controls" })];
    }
    if (/auto/i.test(mode)) {
      return [finding("auto-mode", "info", "Mode is set to automatic",
        "Auto can switch to cooling on mild sunny days and back, wasting energy on underfloor heating.",
        "Use heating mode through the heating season and switch manually in summer.", { control: "controls" })];
    }
    return [];
  },

  function heatingInSummer({ device, recentMean }) {
    const climate = climatePoint(device);
    const mode = String(pointValue(climate, "operationMode") || "heating");
    if (recentMean === null || recentMean < THRESHOLDS.summerMean || !isOn(pointValue(climate, "onOffMode")) || !/heat|auto/i.test(mode)) return [];
    return [finding("summer-heating", "suggest", "Space heating is still on in warm weather",
      `Outdoor mean over the last week is ${fmt(recentMean)}°C.`,
      "Switch space heating off for summer (hot water keeps running), or check that the space-heating OFF temperature on the indoor unit is around 16–18°C.",
      { control: "controls" })];
  },

  function efficiencyTrend({ stats }) {
    const usable = stats.filter((month) => month.kwhPerHdd !== null);
    const recent = usable.slice(-3);
    const pairs = recent.map((month) => [month, usable.find((other) => other.month === `${Number(month.month.slice(0, 4)) - 1}${month.month.slice(4)}`)]).filter(([, before]) => before);
    if (pairs.length < 2) return [];
    const ratio = (list) => list.reduce((sum, month) => sum + month.heat, 0) / list.reduce((sum, month) => sum + month.hdd, 0);
    const now = ratio(pairs.map(([month]) => month));
    const before = ratio(pairs.map(([, month]) => month));
    const change = (now - before) / before;
    const months = pairs.map(([month]) => month.month).join(", ");
    if (change > THRESHOLDS.trendChange) {
      return [finding("trend-worse", "warn", "Heating needs more electricity per cold day than a year ago",
        `${fmt(now, 2)} kWh per degree-day in ${months}, versus ${fmt(before, 2)} the year before (+${Math.round(change * 100)}%).`,
        "Look for a setting change in the journal, the backup heater running, a dirty filter or low system pressure.")];
    }
    if (change < -THRESHOLDS.trendChange) {
      return [finding("trend-better", "info", "Heating is more efficient than a year ago",
        `${fmt(now, 2)} kWh per degree-day in ${months}, versus ${fmt(before, 2)} the year before (${Math.round(change * 100)}%).`,
        "Whatever changed is working. Keep it.")];
    }
    return [];
  },

  function hotWaterShare({ stats, house }) {
    const year = stats.filter((month) => month.complete && month.heat !== null && month.dhw !== null).slice(-12);
    if (year.length < 12) return [];
    const heat = year.reduce((sum, month) => sum + month.heat, 0);
    const dhw = year.reduce((sum, month) => sum + month.dhw, 0);
    if (!heat || dhw / (heat + dhw) <= THRESHOLDS.dhwShare) return [];
    return [finding("hot-water-share", "info", "Hot water is a large share of the electricity",
      `${Math.round((dhw / (heat + dhw)) * 100)}% of the last 12 months (${Math.round(dhw)} kWh)${house?.occupants ? ` for ${house.occupants} people` : ""}.`,
      "Check the tank target, how often disinfection runs, and whether the backup heater helps hot water.", { control: "controls" })];
  },

  function annualBenchmark({ stats, house }) {
    if (!Number.isFinite(house?.area) || house.area <= 0) return [];
    const year = stats.filter((month) => month.complete && month.heat !== null).slice(-12);
    if (year.length < 12) return [];
    const total = year.reduce((sum, month) => sum + (month.heat || 0) + (month.dhw || 0), 0);
    const perArea = total / house.area;
    const benchmark = THRESHOLDS.benchmark[house.insulation || "average"];
    if (!benchmark || perArea <= benchmark) return [];
    return [finding("benchmark", "info", "Yearly use is above a typical figure for this kind of house",
      `${Math.round(total)} kWh over 12 months is ${fmt(perArea)} kWh/m²; a rough figure for ${house.insulation || "average"} insulation is ${benchmark}.`,
      "This is a coarse benchmark that ignores climate. Use it as a prompt to check the curve and setbacks, not as a verdict.")];
  },
];

export function evaluate({ devices = [], house = {}, journal = {}, now = new Date() } = {}) {
  const device = devices[0];
  const today = localDate(now, house?.timeZone);
  const stats = monthlyStats(journal);
  const context = {
    device,
    house: house || {},
    journal,
    stats,
    today,
    emitters: house?.emitters || "underfloor",
    recentMean: recentMeanOutdoor(journal, today),
  };
  const findings = device ? rules.flatMap((rule) => rule(context)) : rules.filter((rule) => ["efficiencyTrend", "hotWaterShare", "annualBenchmark"].includes(rule.name)).flatMap((rule) => rule(context));
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { findings, stats, recentMeanOutdoor: context.recentMean === null ? null : Math.round(context.recentMean * 10) / 10 };
}
