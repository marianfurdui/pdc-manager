import crypto from "node:crypto";
import { AppError } from "./errors.js";

export class RedisSecureStore {
  constructor({ url, token, secret, key = "pdc-control:settings" } = {}) {
    this.url = String(url || "").replace(/\/$/, "");
    this.token = token;
    this.secret = secret;
    this.keyName = key;
    this.key = null;
  }

  async init() {
    if (!this.url || !this.token) throw new AppError("Connect a Redis store to the Vercel project", 503, "REDIS_NOT_CONFIGURED");
    if (!this.secret || String(this.secret).length < 32) throw new AppError("APP_SECRET must contain at least 32 characters", 503, "APP_SECRET_REQUIRED");
    this.key = crypto.createHash("sha256").update(String(this.secret)).digest();
  }

  async command(parts) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(parts),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new AppError(payload.error || "Redis storage request failed", 503, "REDIS_UNAVAILABLE");
    return payload.result;
  }

  async read() {
    const encrypted = await this.command(["GET", this.keyName]);
    if (!encrypted) return {};
    try {
      const wrapper = JSON.parse(encrypted);
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(wrapper.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(wrapper.tag, "base64url"));
      const clear = Buffer.concat([decipher.update(Buffer.from(wrapper.ciphertext, "base64url")), decipher.final()]);
      return JSON.parse(clear.toString("utf8"));
    } catch {
      throw new AppError("Stored settings could not be decrypted", 500, "STORE_DECRYPTION_FAILED");
    }
  }

  async write(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const wrapper = JSON.stringify({
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    });
    await this.command(["SET", this.keyName, wrapper]);
  }
}
