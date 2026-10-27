#!/usr/bin/env node
import { inspectA71Setup } from "../src/connectors/local-altherma.js";

const host = process.argv[2] || "192.168.10.1";
try {
  const result = await inspectA71Setup(host);
  console.log(JSON.stringify(result, null, 2));
  if (!result.reachable) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
