const leaf = (path, value, options = {}) => ({ path, value, settable: false, ...options });

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
      ],
      schedule: {
        settable: true,
        value: { modes: { heating: {
          enabled: { value: true },
          currentSchedule: { value: "1", values: ["1", "2"] },
          schedules: {
            "1": { name: "Comfort", monday: [{ time: "06:00", value: 21 }, { time: "22:30", value: 18 }], saturday: [{ time: "07:30", value: 21 }] },
            "2": { name: "Away", monday: [{ time: "07:00", value: 17 }] },
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
