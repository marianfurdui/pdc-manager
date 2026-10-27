#!/usr/bin/env node
import dgram from "node:dgram";

const host = process.argv[2];
if (!host) {
  console.error("Usage: node scripts/research-a71.mjs <private-ip>");
  process.exit(2);
}

const paths = [
  "/", "/index.html", "/favicon.ico", "/robots.txt",
  "/common/basic_info", "/common/get_version", "/common/get_wifi_setting",
  "/common/get_network_info", "/common/get_remote_method", "/common/get_datetime",
  "/common/get_holiday", "/common/get_notify", "/common/get_regist_info",
  "/common/get_unit_info", "/common/get_device_info", "/common/get_model_info",
  "/aircon/get_model_info", "/aircon/get_sensor_info", "/aircon/get_control_info",
  "/dsiot/multireq", "/mca", "/api", "/api/", "/api/v1", "/v1",
  "/status", "/version", "/health", "/ping", "/info",
  "/gateway", "/gateway/info", "/gateway/status", "/gateway/version",
  "/system/info", "/system/status", "/system/version",
  "/config", "/configuration", "/wifi", "/wifi/scan", "/scan",
  "/wlan", "/network", "/device", "/device/info", "/device/status",
];

async function probeHttp() {
  const findings = [];
  for (const path of paths) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch(`http://${host}${path}`, {
        headers: { accept: "application/json, text/plain, */*" },
        signal: controller.signal,
      });
      const body = await response.text();
      const normal404 = response.status === 404 && /not_found/i.test(body);
      if (!normal404) findings.push({ path, status: response.status, type: response.headers.get("content-type"), body: body.slice(0, 500) });
    } catch (error) {
      findings.push({ path, error: error.name === "AbortError" ? "timeout" : error.message });
    } finally {
      clearTimeout(timer);
    }
  }
  return findings;
}

async function udpRequest(message, port = 30050) {
  const socket = dgram.createSocket("udp4");
  const replies = [];
  socket.on("message", (data, remote) => replies.push({ from: `${remote.address}:${remote.port}`, body: data.toString("utf8") }));
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, () => socket.send(Buffer.from(message), port, host, (error) => error ? reject(error) : resolve()));
  });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  socket.close();
  return replies;
}

const udpMessages = [
  "DAIKIN_UDP/common/basic_info",
  "DAIKIN_UDP/common/get_device_info",
  "DAIKIN_UDP/common/get_unit_info",
  "DAIKIN_UDP/common/get_wifi_setting",
  "DAIKIN_UDP/common/get_network_info",
  "DAIKIN_UDP/common/get_remote_method",
  "DAIKIN_UDP/common/get_datetime",
  "DAIKIN_UDP/common/get_version",
  "DAIKIN_UDP/aircon/get_model_info",
  "DAIKIN_UDP/aircon/get_sensor_info",
  "DAIKIN_UDP/aircon/get_control_info",
  "DAIKIN_UDP/dsiot/multireq",
  "DAIKIN_UDP/mca",
];
const udp = [];
for (const message of udpMessages) udp.push({ message, replies: await udpRequest(message) });

console.log(JSON.stringify({ host, udp, http: await probeHttp() }, null, 2));
