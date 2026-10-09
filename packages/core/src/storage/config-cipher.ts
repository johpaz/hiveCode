import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

interface SecretStore {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<unknown>;
}
const PREFIX = "hive-config:v1:";
const KEY = { service: "hive-code", name: "config-encryption-key.v1" };

/** One installation key in the OS keystore; never derived from a public value. */
export function createConfigCipher(store: SecretStore) {
  let cached: Buffer | undefined;
  let pending: Promise<Buffer> | undefined;
  async function key(create: boolean): Promise<Buffer> {
    if (cached) return cached;
    if (!pending) pending = (async () => {
      let value: string | null;
      try {
        value = await store.get(KEY);
        if (!value && create) {
          value = randomBytes(32).toString("hex");
          await store.set({ ...KEY, value });
        }
      } catch { throw new Error("Configuration encryption keystore is unavailable"); }
      if (!value) throw new Error("Configuration encryption key is missing");
      if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Configuration encryption key is invalid");
      cached = Buffer.from(value, "hex");
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  return {
    async encrypt(plain: unknown): Promise<{ encrypted: string; iv: string }> {
      const serialized = JSON.stringify(plain);
      if (serialized === undefined) throw new Error("Configuration must be JSON serializable");
      const secret = await key(true);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, iv);
      const data = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
      return { encrypted: PREFIX + data.toString("base64") + ":" + cipher.getAuthTag().toString("base64"), iv: iv.toString("base64") };
    },
    async decrypt(encrypted: string | null | undefined, iv?: string | null): Promise<any> {
      if (!encrypted) return {};
      if (!encrypted.startsWith(PREFIX)) {
        throw new Error("Unsupported configuration encryption format; reset records before using legacy configurations");
      }
      const secret = await key(false);
      try {
        const [data, tag, extra] = encrypted.slice(PREFIX.length).split(":");
        if (!data || !tag || extra !== undefined || !iv) throw new Error();
        const nonce = Buffer.from(iv, "base64"), authTag = Buffer.from(tag, "base64");
        if (nonce.length !== 12 || authTag.length !== 16) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", secret, nonce);
        decipher.setAuthTag(authTag);
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
      } catch { throw new Error("Configuration ciphertext is invalid or authentication failed"); }
    },
  };
}
