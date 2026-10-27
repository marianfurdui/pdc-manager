import test from "node:test";
import assert from "node:assert/strict";
import { activeSchedule, evaluate, monthlyStats } from "../src/lib/efficiency.js";
import { emptyJournal } from "../src/lib/journal.js";

const leaf = (path, value, options = {}) => ({ path, value, settable: false, ...options });

function device({ room = 21, roomTarget = 21, offset = 0, mode = "heating", power = "on", tank = 48, boost = false, schedule = null, dhwSchedule = null, extra = [] } = {}) {
  return {
    id: "device",
    source: "cloud",
    points: [
      {
        id: "climateControl",
        type: "climateControl",
        characteristics: [
          { name: "onOffMode", leaves: [leaf("", power, { settable: true, values: ["on", "off"] })] },
          { name: "operationMode", leaves: [leaf("", mode, { settable: true, values: ["heating", "cooling", "auto"] })] },
          { name: "operationState", leaves: [leaf("", "heating")] },
          { name: "sensoryData", leaves: [leaf("/roomTemperature", room), leaf("/outdoorTemperature", 5)] },
          { name: "temperatureControl", leaves: [
            leaf("/operationModes/heating/setpoints/roomTemperature", roomTarget, { settable: true }),
            leaf("/operationModes/cooling/setpoints/roomTemperature", 26, { settable: true }),
            leaf("/operationModes/heating/setpoints/leavingWaterOffset", offset, { settable: true }),
          ] },
          ...extra,
        ],
        schedule,
      },
      {
        id: "domesticHotWaterTank",
        type: "domesticHotWaterTank",
        characteristics: [
          { name: "onOffMode", leaves: [leaf("", "on", { settable: true, values: ["on", "off"] })] },
          { name: "temperatureControl", leaves: [leaf("/operationModes/heating/setpoints/domesticHotWaterTemperature", tank, { settable: true })] },
          { name: "powerfulMode", leaves: [leaf("", boost ? "on" : "off", { settable: true, values: ["on", "off"] })] },
        ],
        schedule: dhwSchedule,
      },
    ],
  };
}

const ids = (result) => result.findings.map((item) => item.id);
const winter = new Date("2026-01-15T12:00:00Z");
const summer = new Date("2026-07-15T12:00:00Z");

function heatingSamples(count, sample) {
  return Array.from({ length: count }, (_, index) => ({ t: new Date(winter.getTime() - index * 3_600_000).toISOString(), cs: "heating", ts: "idle", cp: true, ...sample }));
}

function weekSchedule(days, enabled = true) {
  return { settable: true, value: { modes: { heating: { enabled: { value: enabled }, currentSchedule: { value: "1" }, schedules: { "1": { name: "Main", ...days } } } } } };
}

test("a well-set unit produces no findings", () => {
  const result = evaluate({ devices: [device()], house: { dayTemp: 21 }, journal: emptyJournal(), now: winter });
  assert.deepEqual(ids(result), []);
});

test("no device and no history produces no findings", () => {
  assert.deepEqual(ids(evaluate({ devices: [], journal: emptyJournal(), now: winter })), []);
});

test("rules stay silent when the unit does not report their data", () => {
  const bare = { id: "bare", source: "cloud", points: [{ id: "gateway", type: "gateway", characteristics: [] }] };
  assert.deepEqual(ids(evaluate({ devices: [bare], journal: emptyJournal(), now: winter })), []);
});

test("room target above the profile preference is flagged with a saving", () => {
  const result = evaluate({ devices: [device({ roomTarget: 22.5 })], house: { dayTemp: 21 }, journal: emptyJournal(), now: winter });
  const item = result.findings.find((finding) => finding.id === "room-target");
  assert.ok(item);
  assert.match(item.estimate, /about 9%/);
  assert.equal(ids(evaluate({ devices: [device({ roomTarget: 21.5 })], journal: emptyJournal(), now: winter })).includes("room-target"), false);
});

test("a positive water offset is flagged, zero is not", () => {
  assert.ok(ids(evaluate({ devices: [device({ offset: 2 })], journal: emptyJournal(), now: winter })).includes("water-offset"));
  assert.equal(ids(evaluate({ devices: [device({ offset: 0 })], journal: emptyJournal(), now: winter })).includes("water-offset"), false);
});

test("leaving water above the underfloor band needs enough readings", () => {
  const hot = { ...emptyJournal(), samples: heatingSamples(12, { o: 5, lw: 36 }) };
  assert.ok(ids(evaluate({ devices: [device()], journal: hot, now: winter })).includes("water-too-hot"));
  const few = { ...emptyJournal(), samples: heatingSamples(5, { o: 5, lw: 36 }) };
  assert.equal(ids(evaluate({ devices: [device()], journal: few, now: winter })).includes("water-too-hot"), false);
  const fine = { ...emptyJournal(), samples: heatingSamples(12, { o: 5, lw: 30 }) };
  assert.equal(ids(evaluate({ devices: [device()], journal: fine, now: winter })).includes("water-too-hot"), false);
  const radiators = evaluate({ devices: [device()], house: { emitters: "radiators" }, journal: hot, now: winter });
  assert.equal(ids(radiators).includes("water-too-hot"), false);
});

test("a well-insulated house is held to a lower water temperature", () => {
  // At 0 °C outside the underfloor band allows 31 °C; well insulated, 29.2 °C.
  const journal = { ...emptyJournal(), samples: heatingSamples(12, { o: 0, lw: 33 }) };
  assert.equal(ids(evaluate({ devices: [device()], house: { insulation: "average" }, journal, now: winter })).includes("water-too-hot"), false);
  const insulated = evaluate({ devices: [device()], house: { insulation: "new" }, journal, now: winter });
  assert.match(insulated.findings.find((item) => item.id === "water-too-hot").evidence, /well-insulated/);
});

test("samples taken while hot water heats are ignored", () => {
  const journal = { ...emptyJournal(), samples: heatingSamples(12, { o: 5, lw: 50, ts: "heating" }) };
  assert.equal(ids(evaluate({ devices: [device()], journal, now: winter })).includes("water-too-hot"), false);
});

test("rooms running above target are flagged", () => {
  const journal = { ...emptyJournal(), samples: heatingSamples(12, { r: 22.4, rt: 21 }) };
  assert.ok(ids(evaluate({ devices: [device()], journal, now: winter })).includes("rooms-overshoot"));
});

test("deep schedule setbacks are flagged for underfloor heating only", () => {
  const schedule = weekSchedule({ monday: [{ time: "06:00", value: 21 }, { time: "22:00", value: 18 }] });
  assert.ok(ids(evaluate({ devices: [device({ schedule })], journal: emptyJournal(), now: winter })).includes("deep-setback"));
  const gentle = weekSchedule({ monday: [{ time: "06:00", value: 21 }, { time: "22:00", value: 20 }] });
  assert.equal(ids(evaluate({ devices: [device({ schedule: gentle })], journal: emptyJournal(), now: winter })).includes("deep-setback"), false);
  const paused = weekSchedule({ monday: [{ time: "06:00", value: 21 }, { time: "22:00", value: 18 }] }, false);
  assert.equal(ids(evaluate({ devices: [device({ schedule: paused })], journal: emptyJournal(), now: winter })).includes("deep-setback"), false);
});

test("schedules keyed by start time are understood", () => {
  const point = { schedule: weekSchedule({ actions: { monday: { "0600": { roomTemperature: 21 }, "2200": { roomTemperature: 18 } } } }) };
  const schedule = activeSchedule(point, "heating");
  assert.deepEqual(schedule.week.monday, [{ minutes: 360, target: 21 }, { minutes: 1320, target: 18 }]);
});

test("room thermostats on underfloor heating get advice tied to the target", () => {
  const result = evaluate({ devices: [device({ roomTarget: 21 })], house: { roomThermostats: "some" }, journal: emptyJournal(), now: winter });
  const item = result.findings.find((finding) => finding.id === "room-thermostats");
  assert.match(item.suggestion, /22–23°C/);
  assert.equal(ids(evaluate({ devices: [device()], house: { roomThermostats: "none" }, journal: emptyJournal(), now: winter })).includes("room-thermostats"), false);
  assert.equal(ids(evaluate({ devices: [device()], house: { roomThermostats: "all", emitters: "radiators" }, journal: emptyJournal(), now: winter })).includes("room-thermostats"), false);
});

const rooms = [
  { name: "Living and kitchen", area: 55, target: 21 },
  { name: "Bedroom", area: 16, target: 21 },
  { name: "Bathroom", area: 7, target: 19 },
  { name: "Office", area: 10, target: 19 },
  { name: "Small bedroom", area: 9, target: 17 },
  { name: "Dressing", area: 5, target: 15 },
];

test("rooms kept well below the main rooms are named for balancing", () => {
  const item = evaluate({ devices: [device()], house: { rooms }, journal: emptyJournal(), now: winter }).findings.find((finding) => finding.id === "room-balance");
  assert.match(item.evidence, /^Dressing 15°C, Small bedroom 17°C, Bathroom 19°C, Office 19°C are 2°C or more below the main rooms \(21°C\), 31 m²/);
  const even = rooms.map((room) => ({ ...room, target: 21 }));
  assert.equal(ids(evaluate({ devices: [device()], house: { rooms: even }, journal: emptyJournal(), now: winter })).includes("room-balance"), false);
});

test("rooms dropped deeply at night are listed, deepest first", () => {
  const nightRooms = [
    { name: "Living", area: 40, day: 21, night: 20 },
    { name: "Bedroom", area: 16, day: 21, night: 18 },
    { name: "Office", area: 10, day: 19, night: 16 },
    { name: "Bath", area: 7, day: 19 },
  ];
  const item = evaluate({ devices: [device()], house: { rooms: nightRooms }, journal: emptyJournal(), now: winter }).findings.find((finding) => finding.id === "room-night-setback");
  assert.equal(item.evidence, "Bedroom 21°C to 18°C, Office 19°C to 16°C.");
  const gentle = nightRooms.map((room) => ({ ...room, night: room.day - 1 }));
  assert.equal(ids(evaluate({ devices: [device()], house: { rooms: gentle }, journal: emptyJournal(), now: winter })).includes("room-night-setback"), false);
});

test("day temperatures drive the balancing check", () => {
  const dayNight = rooms.map(({ target, ...room }) => ({ ...room, day: target, night: target - 1 }));
  assert.ok(ids(evaluate({ devices: [device()], house: { rooms: dayNight }, journal: emptyJournal(), now: winter })).includes("room-balance"));
});

test("per-room data changes the thermostat advice", () => {
  const item = evaluate({ devices: [device()], house: { roomThermostats: "all", rooms }, journal: emptyJournal(), now: winter }).findings.find((finding) => finding.id === "room-thermostats");
  assert.match(item.suggestion, /each room's thermostat/);
});

test("window-only ventilation gets airing advice in the heating season", () => {
  const item = evaluate({ devices: [device()], house: { ventilation: "windows", insulation: "new", roomThermostats: "all" }, journal: emptyJournal(), now: winter }).findings.find((finding) => finding.id === "window-airing");
  assert.match(item.evidence, /well-insulated/);
  assert.match(item.suggestion, /thermostat/);
  assert.equal(ids(evaluate({ devices: [device()], house: { ventilation: "recovery" }, journal: emptyJournal(), now: winter })).includes("window-airing"), false);
});

function sensorJournal(offset, { days = 4, perDay = 6 } = {}) {
  const journal = emptyJournal();
  journal.weather = { key: "x", daily: {}, hourly: {} };
  for (let day = 0; day < days; day += 1) {
    for (let hour = 8; hour < 8 + perDay; hour += 1) {
      const t = new Date(Date.UTC(2026, 0, 10 + day, hour, 20)).toISOString();
      journal.weather.hourly[t.slice(0, 13)] = 2;
      journal.samples.push({ t, o: 2 + offset + (hour === 9 ? 6 : 0) });
    }
  }
  return journal;
}

test("the outdoor sensor is compared with weather data at the same hour", () => {
  const result = evaluate({ devices: [device()], journal: sensorJournal(2.5), now: winter });
  assert.deepEqual(result.sensorCheck, { offset: 2.5, readings: 24, days: 4 }, "the defrost-like spike is ignored by the median");
  const item = result.findings.find((finding) => finding.id === "weather-offset");
  assert.match(item.title, /2\.5°C warmer/);
  assert.match(item.suggestion, /altitude/);
  const withAltitude = evaluate({ devices: [device()], house: { elevation: 400 }, journal: sensorJournal(-2), now: winter }).findings.find((finding) => finding.id === "weather-offset");
  assert.match(withAltitude.suggestion, /colder than the weather data/);
  assert.equal(ids(evaluate({ devices: [device()], journal: sensorJournal(1), now: winter })).includes("weather-offset"), false);
  assert.equal(evaluate({ devices: [device()], journal: sensorJournal(3, { days: 2 }), now: winter }).sensorCheck, null);
});

test("thin insulation over an unheated basement is flagged", () => {
  assert.ok(ids(evaluate({ devices: [device()], house: { belowFloor: "basement", slabInsulation: 5 }, journal: emptyJournal(), now: winter })).includes("floor-loss"));
  assert.equal(ids(evaluate({ devices: [device()], house: { belowFloor: "basement", slabInsulation: 10 }, journal: emptyJournal(), now: winter })).includes("floor-loss"), false);
  assert.equal(ids(evaluate({ devices: [device()], house: { belowFloor: "basement" }, journal: emptyJournal(), now: winter })).includes("floor-loss"), false);
  // 80 m² at U ≈ 0.55 and a 17 °C difference loses about 0.75 kW.
  const sized = evaluate({ devices: [device()], house: { belowFloor: "basement", slabInsulation: 5, basementArea: 80 }, journal: emptyJournal(), now: winter }).findings.find((finding) => finding.id === "floor-loss");
  assert.match(sized.evidence, /80 m² that is roughly 0\.8 kW/);
  assert.match(sized.estimate, /^about \d+ kWh of electricity a year with 10 cm added$/);
});

test("hot water above 50 °C and boost are reported", () => {
  const result = evaluate({ devices: [device({ tank: 55, boost: true })], journal: emptyJournal(), now: winter });
  assert.ok(ids(result).includes("tank-target"));
  assert.ok(ids(result).includes("boost-on"));
  assert.equal(ids(evaluate({ devices: [device({ tank: 50 })], journal: emptyJournal(), now: winter })).includes("tank-target"), false);
});

test("night hot water is flagged on a flat tariff but not on a night tariff", () => {
  const dhwSchedule = weekSchedule({ monday: [{ time: "02:00", value: 50 }, { time: "06:00", value: 40 }] });
  assert.ok(ids(evaluate({ devices: [device({ dhwSchedule })], house: { tariff: "flat" }, journal: emptyJournal(), now: winter })).includes("night-hot-water"));
  assert.equal(ids(evaluate({ devices: [device({ dhwSchedule })], house: { tariff: "dual" }, journal: emptyJournal(), now: winter })).includes("night-hot-water"), false);
});

test("mode checks follow the season", () => {
  assert.ok(ids(evaluate({ devices: [device({ mode: "cooling" })], journal: emptyJournal(), now: winter })).includes("cooling-in-winter"));
  assert.ok(ids(evaluate({ devices: [device({ mode: "auto" })], journal: emptyJournal(), now: winter })).includes("auto-mode"));
  assert.equal(ids(evaluate({ devices: [device({ mode: "auto" })], journal: emptyJournal(), now: summer })).includes("auto-mode"), false);
});

test("space heating left on in a warm week is flagged", () => {
  const journal = emptyJournal();
  journal.weather = { key: "x", daily: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`2026-07-${String(8 + index).padStart(2, "0")}`, 20])) };
  assert.ok(ids(evaluate({ devices: [device()], journal, now: summer })).includes("summer-heating"));
  assert.equal(ids(evaluate({ devices: [device({ power: "off" })], journal, now: summer })).includes("summer-heating"), false);
});

test("backup heater activity and faults are warnings", () => {
  const extra = [
    { name: "backupHeaterState", leaves: [leaf("", "on")] },
    { name: "isInErrorState", leaves: [leaf("", true)] },
    { name: "errorCode", leaves: [leaf("", "U4")] },
  ];
  const result = evaluate({ devices: [device({ extra })], journal: emptyJournal(), now: winter });
  assert.ok(ids(result).includes("backup-heater"));
  const fault = result.findings.find((item) => item.id.startsWith("fault-"));
  assert.match(fault.evidence, /U4/);
  assert.equal(result.findings[0].severity, "warn");
});

function yearsOfHistory(heatPerHdd) {
  const journal = emptyJournal();
  journal.weather = { key: "x", daily: {} };
  for (const year of [2024, 2025]) {
    for (let month = 1; month <= 12; month += 1) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const mean = month <= 3 || month >= 11 ? 2 : 18;
      for (let day = 1; day <= days; day += 1) journal.weather.daily[`${key}-${String(day).padStart(2, "0")}`] = mean;
      const hdd = Math.max(0, 15.5 - mean) * days;
      journal.monthly[key] = { heat: Math.round(hdd * heatPerHdd(year) * 10) / 10, dhw: 60 };
    }
  }
  return journal;
}

test("monthly stats divide heating by degree-days for complete months", () => {
  const stats = monthlyStats(yearsOfHistory(() => 0.5));
  const january = stats.find((month) => month.month === "2025-01");
  assert.equal(january.hdd, 418.5);
  assert.equal(january.kwhPerHdd, 0.5);
  assert.equal(stats.find((month) => month.month === "2025-07").kwhPerHdd, null);
});

test("a worse or better kWh per degree-day than last year is reported", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  assert.ok(ids(evaluate({ journal: yearsOfHistory((year) => (year === 2025 ? 0.7 : 0.5)), now })).includes("trend-worse"));
  assert.ok(ids(evaluate({ journal: yearsOfHistory((year) => (year === 2025 ? 0.4 : 0.5)), now })).includes("trend-better"));
  assert.equal(ids(evaluate({ journal: yearsOfHistory(() => 0.5), now })).some((id) => id.startsWith("trend")), false);
});

test("yearly benchmark needs floor area and a full year", () => {
  const journal = yearsOfHistory(() => 1);
  const now = new Date("2026-01-10T12:00:00Z");
  assert.ok(ids(evaluate({ journal, house: { area: 50, insulation: "new" }, now })).includes("benchmark"));
  assert.equal(ids(evaluate({ journal, house: { area: 1000, insulation: "new" }, now })).includes("benchmark"), false);
  assert.equal(ids(evaluate({ journal, now })).includes("benchmark"), false);
  assert.ok(ids(evaluate({ journal, house: { rooms: [{ name: "All", area: 50, target: 21 }], insulation: "new" }, now })).includes("benchmark"), "falls back to the rooms' total area");
});
