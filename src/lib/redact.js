// Removes identifying values from a raw ONECTA payload while keeping its
// structure, readings, ranges and units, so it can be inspected or shared.
const SENSITIVE_KEY = /^(id|name|serialnumber|macaddress|ipaddress|ssid|wificonnectionssid|email|accountid|userid|ownerid|qrcode|registrationcode|latitude|longitude|location|timezone|.*serial.*|.*mac(address)?|.*ssid.*|.*uuid.*)$/i;
const SENSITIVE_VALUE = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
];

export function redactPayload(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => redactPayload(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => {
      if (SENSITIVE_KEY.test(childKey) && childKey !== "embeddedId") return [childKey, redactLeaf(child)];
      return [childKey, redactPayload(child, childKey)];
    }));
  }
  if (typeof value === "string" && SENSITIVE_VALUE.some((pattern) => pattern.test(value))) return "<redacted>";
  return value;
}

// A sensitive key may hold a plain value or an ONECTA { value, settable }
// wrapper; keep the wrapper's metadata so the structure stays readable.
function redactLeaf(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")) {
    return { ...redactPayload({ ...value, value: undefined }), value: "<redacted>" };
  }
  return "<redacted>";
}
