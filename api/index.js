import { createRequestHandler } from "../src/app-handler.js";
import { RedisSecureStore } from "../src/lib/redis-store.js";

const publicUrl = process.env.PUBLIC_URL || "https://hp.operagrid.net";
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

if (!process.env.APP_PASSWORD) {
  throw new Error("APP_PASSWORD is required for the hosted dashboard");
}

const handlerPromise = createRequestHandler({
  store: new RedisSecureStore({
    url: redisUrl,
    token: redisToken,
    secret: process.env.APP_SECRET,
  }),
  host: "vercel",
  appPassword: process.env.APP_PASSWORD || "",
  publicUrl,
  localEnabled: false,
  runtime: "vercel",
});

function restoreOriginalUrl(request) {
  const url = new URL(request.url || "/", "http://localhost");
  const kind = url.searchParams.get("__kind");
  const routedPath = url.searchParams.get("__path") || "";
  url.searchParams.delete("__kind");
  url.searchParams.delete("__path");
  const suffix = url.searchParams.size ? `?${url.searchParams}` : "";
  if (kind === "oauth") return `/oauth/callback${suffix}`;
  if (kind === "api") return `/api/${routedPath}${suffix}`;
  if (kind === "static") return `/${routedPath}${suffix}`;
  return request.url || "/";
}

export default async function handler(request, response) {
  request.url = restoreOriginalUrl(request);
  return (await handlerPromise)(request, response);
}
