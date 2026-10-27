// Helpers for reading normalized ONECTA devices (see normalizeCloudDevices).
// Every lookup is by key pattern so callers degrade to "not found" when a
// unit does not report a characteristic.

export function pointEntries(point) {
  return (point.characteristics || []).flatMap((characteristic) =>
    (characteristic.leaves || []).map((leaf) => ({
      point,
      characteristic,
      leaf,
      key: `${point.type || ""} ${characteristic.name || ""} ${leaf.path || ""}`.toLowerCase(),
    })));
}

export function deviceEntries(device) {
  return (device?.points || []).flatMap(pointEntries);
}

export function findEntry(entries, patterns, predicate = () => true) {
  for (const pattern of patterns) {
    const found = entries.find((entry) => pattern.test(entry.key) && predicate(entry));
    if (found) return found;
  }
  return null;
}

export const isNumber = (entry) => typeof entry.leaf.value === "number" && Number.isFinite(entry.leaf.value);
export const isReading = (entry) => !entry.leaf.settable && isNumber(entry);
export const isTankPoint = (point) => /domestichotwater/i.test(point?.type || "");
export const isClimatePoint = (point) => /climatecontrol/i.test(point?.type || "");

export function climatePoint(device) {
  return (device?.points || []).find(isClimatePoint) || null;
}

export function tankPoint(device) {
  return (device?.points || []).find(isTankPoint) || null;
}

export function pointValue(point, characteristic) {
  if (!point) return undefined;
  return pointEntries(point).find((entry) => entry.characteristic.name === characteristic && !entry.leaf.path)?.leaf.value;
}

// The setpoint the unit is working to in its current operation mode, or a
// mode-independent one when the unit has no per-mode setpoints.
export function activeSetpoint(point, names) {
  if (!point) return null;
  const mode = String(pointValue(point, "operationMode") || "").toLowerCase();
  const candidates = pointEntries(point).filter((entry) => entry.leaf.settable && isNumber(entry));
  const forMode = candidates.filter((entry) => !/\/operationmodes\//.test(entry.key) || (mode && entry.key.includes(`/operationmodes/${mode}/`)));
  const pool = forMode.length ? forMode : candidates;
  for (const name of names) {
    const found = pool.find((entry) => entry.key.endsWith(name.toLowerCase()));
    if (found) return found;
  }
  return null;
}

export function isOn(value) {
  return value === true || value === "on";
}
