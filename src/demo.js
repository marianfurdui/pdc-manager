const leaf = (path, value, options = {}) => ({ path, value, settable: false, ...options });
// Shaped like ONECTA consumptionData: d = 2-hour buckets for yesterday then
// today, w = days of last week then this week, m = months of last year then
// this year. Future buckets are null.
const kwh = (values) => values.map((value) => (value === null ? null : Math.round(value * 10) / 10));
const consumption = (scale) => ({ name: "consumptionData", leaves: [
  leaf("/electrical/heating/d", kwh([0.9, 0.7, 0.6, 1.4, 1.1, 0.8, 0.7, 0.9, 1.2, 1.5, 1.3, 1.0, 1.0, 0.8, 0.7, 1.6, 1.2, 0.9, null, null, null, null, null, null].map((v) => v && v * scale)), { unit: "kWh" }),
  leaf("/electrical/heating/w", kwh([10.2, 11.4, 9.8, 12.1, 10.6, 13.3, 12.8, 9.4, 10.1, 8.7, null, null, null, null].map((v) => v && v * scale)), { unit: "kWh" }),
  leaf("/electrical/heating/m", kwh([412, 366, 298, 174, 88, 41, 32, 30, 52, 140, 262, 371, 398, 341, 271, 160, 79, 38, 29, 28, 47, 129, null, null].map((v) => v && v * scale)), { unit: "kWh" }),
] });
const comfortDay = [{ time: "06:00", value: 21 }, { time: "08:30", value: 19 }, { time: "16:30", value: 21.5 }, { time: "22:30", value: 18 }];
const weekendDay = [{ time: "07:30", value: 21 }, { time: "23:00", value: 18 }];

export const demoCloudDevice = {
  id: "demo-altherma",
  source: "cloud",
  name: "Home",
  model: "ETVX16S23D9W + EPRA14DW1",
  firmware: "demo",
  online: true,
  updatedAt: new Date().toISOString(),
  points: [
    {
      id: "climateControl",
      type: "climateControl",
      name: "Main zone",
      characteristics: [
        { name: "onOffMode", leaves: [leaf("", "on", { settable: true, values: ["on", "off"] })] },
        { name: "operationMode", leaves: [leaf("", "heating", { settable: true, values: ["heating", "cooling", "auto"] })] },
        { name: "operationState", leaves: [leaf("", "heating")] },
        { name: "sensoryData", leaves: [
          leaf("/roomTemperature", 21.4, { unit: "°C" }),
          leaf("/outdoorTemperature", 6.8, { unit: "°C" }),
          leaf("/leavingWaterTemperature", 34.6, { unit: "°C" }),
        ] },
        { name: "temperatureControl", leaves: [
          leaf("/operationModes/heating/setpoints/roomTemperature", 21.5, { settable: true, min: 12, max: 30, step: 0.5, unit: "°C" }),
          leaf("/operationModes/cooling/setpoints/roomTemperature", 24, { settable: true, min: 18, max: 30, step: 0.5, unit: "°C" }),
          leaf("/operationModes/heating/setpoints/leavingWaterOffset", 0, { settable: true, min: -10, max: 10, step: 1, unit: "°C" }),
        ] },
        consumption(1),
      ],
      schedule: {
        settable: true,
        value: { modes: { heating: {
          enabled: { value: true },
          currentSchedule: { value: "1", values: ["1", "2"] },
          schedules: {
            "1": { name: "Comfort", monday: comfortDay, tuesday: comfortDay, wednesday: comfortDay, thursday: comfortDay, friday: comfortDay, saturday: weekendDay, sunday: weekendDay },
            "2": { name: "Away", monday: [{ time: "07:00", value: 17 }], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] },
          },
        } } },
      },
    },
    {
      id: "domesticHotWaterTank",
      type: "domesticHotWaterTank",
      name: "Hot water",
      characteristics: [
        { name: "onOffMode", leaves: [leaf("", "on", { settable: true, values: ["on", "off"] })] },
        { name: "operationState", leaves: [leaf("", "idle")] },
        { name: "sensoryData", leaves: [leaf("/tankTemperature", 48.2, { unit: "°C" })] },
        { name: "temperatureControl", leaves: [leaf("/setpoints/domesticHotWaterTemperature", 50, { settable: true, min: 35, max: 60, step: 1, unit: "°C" })] },
        { name: "powerfulMode", leaves: [leaf("", false, { settable: true })] },
        consumption(0.35),
      ],
      schedule: null,
    },
    {
      id: "gateway",
      type: "gateway",
      name: "Gateway",
      characteristics: [
        { name: "cloudConnection", leaves: [leaf("", "connected")] },
        { name: "firmwareVersion", leaves: [leaf("", "3.4.1")] },
      ],
      schedule: null,
    },
  ],
};
