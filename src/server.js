import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "./app-handler.js";
import { SecureStore } from "./lib/store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const demoMode = process.env.DEMO_MODE === "true";
const appPassword = process.env.APP_PASSWORD || "";

if (host !== "127.0.0.1" && host !== "localhost" && !appPassword) {
  console.error("Refusing a non-loopback bind without APP_PASSWORD.");
  process.exit(1);
}

const handler = await createRequestHandler({
  store: new SecureStore(dataDirectory, process.env.APP_SECRET),
  host,
  port,
  demoMode,
  appPassword,
  publicUrl: process.env.PUBLIC_URL || "",
  localEnabled: true,
  runtime: "local",
});

const server = http.createServer(handler);
server.requestTimeout = 65_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 10_000;
server.listen(port, host, () => console.log(`Altherma Control listening on http://${host}:${port}${demoMode ? " (demo)" : ""}`));
