import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class SecureStore {
  constructor(directory, environmentSecret) {
    this.directory = directory;
    this.file = path.join(directory, "settings.enc.json");
    this.keyFile = path.join(directory, ".master-key");
    this.environmentSecret = environmentSecret;
    this.key = null;
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let material = this.environmentSecret;
    if (!material) {
      try {
        material = await fs.readFile(this.keyFile, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        material = crypto.randomBytes(32).toString("base64url");
        await fs.writeFile(this.keyFile, material, { mode: 0o600 });
      }
    }
    this.key = crypto.createHash("sha256").update(material).digest();
  }

  async read() {
    try {
      const wrapper = JSON.parse(await fs.readFile(this.file, "utf8"));
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(wrapper.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(wrapper.tag, "base64url"));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(wrapper.ciphertext, "base64url")),
        decipher.final(),
      ]);
      return JSON.parse(clear.toString("utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async write(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const temporary = `${this.file}.${process.pid}.tmp`;
    const wrapper = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    await fs.writeFile(temporary, JSON.stringify(wrapper), { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }
}
