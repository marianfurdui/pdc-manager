import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCloudDevices, validateWritableValue } from "../src/connectors/onecta.js";

test("ONECTA payload becomes capability-driven management points", () => {
  const [device] = normalizeCloudDevices([{
    id: "device-1",
    deviceModel: "ETVX16S23D9W",
    isCloudConnectionUp: { value: true },
    managementPoints: [{
      embeddedId: "climateControl",
      managementPointType: "climateControl",
      name: { value: "Living room" },
      onOffMode: { settable: true, value: "on", values: ["on", "off"] },
      temperatureControl: {
        settable: true,
        value: { operationModes: { heating: { setpoints: { roomTemperature: { value: 21, settable: true, minValue: 12, maxValue: 30, stepValue: .5, unit: "°C" } } } } },
      },
      schedule: { value: { modes: { any: { enabled: true } } } },
    }],
  }]);
  assert.equal(device.name, "Living room");
  assert.equal(device.points[0].schedule.value.modes.any.enabled, true);
  const temperature = device.points[0].characteristics.find((item) => item.name === "temperatureControl").leaves[0];
  assert.equal(temperature.path, "/operationModes/heating/setpoints/roomTemperature");
  assert.equal(temperature.value, 21);
  assert.equal(temperature.settable, true);
  assert.equal(temperature.min, 12);
});

test("ONECTA writes are constrained to advertised values and ranges", () => {
  assert.equal(validateWritableValue({ value: "on", values: ["on", "off"] }, "off"), "off");
  assert.equal(validateWritableValue({ value: 21, min: 12, max: 30 }, 22.5), 22.5);
  assert.throws(() => validateWritableValue({ value: "on", values: ["on", "off"] }, "boost"), /not one of the options/);
  assert.throws(() => validateWritableValue({ value: 21, min: 12, max: 30 }, 31), /at most 30/);
  assert.throws(() => validateWritableValue({ value: false }, "true"), /on\/off value/);
});
