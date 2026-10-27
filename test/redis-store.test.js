import test from "node:test";
import assert from "node:assert/strict";
import { RedisSecureStore } from "../src/lib/redis-store.js";

test("Redis store encrypts settings and round-trips them", async () => {
  const originalFetch = globalThis.fetch;
  let stored = null;
  globalThis.fetch = async (_url, options) => {
    const [command, _key, value] = JSON.parse(options.body);
    if (command === "GET") return new Response(JSON.stringify({ result: stored }), { status: 200 });
    if (command === "SET") {
      stored = value;
      return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unsupported" }), { status: 400 });
  };

  try {
    const store = new RedisSecureStore({
      url: "https://redis.invalid",
      token: "test-token",
      secret: "a-stable-test-secret-with-more-than-32-characters",
    });
    await store.init();
    await store.write({ onecta: { clientSecret: "never-visible", tokens: { access_token: "hidden" } } });
    assert.equal(stored.includes("never-visible"), false);
    assert.equal(stored.includes("hidden"), false);
    assert.deepEqual(await store.read(), { onecta: { clientSecret: "never-visible", tokens: { access_token: "hidden" } } });

    const wrongKey = new RedisSecureStore({
      url: "https://redis.invalid",
      token: "test-token",
      secret: "a-different-test-secret-with-more-than-32-characters",
    });
    await wrongKey.init();
    await assert.rejects(() => wrongKey.read(), /could not be decrypted/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Redis store refuses incomplete production configuration", async () => {
  await assert.rejects(() => new RedisSecureStore({}).init(), /Connect a Redis store/);
  await assert.rejects(() => new RedisSecureStore({ url: "https://redis.invalid", token: "token", secret: "short" }).init(), /at least 32 characters/);
});
