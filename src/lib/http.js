import { AppError } from "./errors.js";

export async function readJson(request, maxBytes = 64 * 1024) {
  const type = request.headers["content-type"] || "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new AppError("Content-Type must be application/json", 415, "JSON_REQUIRED");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new AppError("Request body is too large", 413, "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("Invalid JSON", 400, "INVALID_JSON");
  }
}

export function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

export function safeSegment(value, label = "path segment") {
  if (typeof value !== "string" || !value || value.length > 160 || /[\0-\x1f]/.test(value)) {
    throw new AppError(`Invalid ${label}`, 400, "INVALID_PATH");
  }
  return encodeURIComponent(value);
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new AppError(`Timed out contacting ${new URL(url).host}`, 504, "UPSTREAM_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
