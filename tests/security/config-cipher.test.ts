import { expect, test } from "bun:test"
import { createConfigCipher } from "../../packages/core/src/storage/config-cipher"
import { deserializeConfig } from "../../packages/core/src/storage/crypto"

function memoryStore(initial: string | null = null) {
 let value = initial, writes = 0
 return {
  get: async () => value,
  set: async (options: { value: string }) => { value = options.value; writes++ },
  get writes() { return writes },
 }
}
test("configuration is encrypted, authenticated and readable after restart", async () => {
 const store = memoryStore(), cipher = createConfigCipher(store)
 const input = { Authorization: "Bearer dummy-test-secret", nested: { enabled: true } }
 const encrypted = await cipher.encrypt(input)
 expect(encrypted.encrypted).not.toContain("dummy-test-secret")
 expect(encrypted.encrypted).not.toContain("Authorization")
 expect(encrypted.iv).not.toBe("legacy")
 expect(await createConfigCipher(store).decrypt(encrypted.encrypted, encrypted.iv)).toEqual(input)
 expect(store.writes).toBe(1)
})
test("each encryption uses a fresh nonce and concurrent calls share one key", async () => {
 const store = memoryStore(), cipher = createConfigCipher(store)
 const values = await Promise.all(Array.from({ length: 8 }, () => cipher.encrypt({ secret: "dummy" })))
 expect(new Set(values.map(v => v.iv)).size).toBe(8)
 expect(store.writes).toBe(1)
})
test("tampering and a different key are rejected", async () => {
 const cipher = createConfigCipher(memoryStore())
 const envelope = await cipher.encrypt({ secret: "dummy" })
 const offset = "hive-config:v1:".length
 const modified = envelope.encrypted.slice(0, offset) + (envelope.encrypted[offset] === "A" ? "B" : "A") + envelope.encrypted.slice(offset + 1)
 await expect(cipher.decrypt(modified, envelope.iv)).rejects.toThrow("authentication failed")
 await expect(cipher.decrypt(envelope.encrypted, Buffer.alloc(12).toString("base64"))).rejects.toThrow("authentication failed")
 await expect(createConfigCipher(memoryStore("ff".repeat(32))).decrypt(envelope.encrypted, envelope.iv)).rejects.toThrow("authentication failed")
})
test("legacy plaintext is rejected without accessing the keystore", async () => {
 const cipher = createConfigCipher({ get: async () => { throw new Error("unavailable") }, set: async () => {} })
 await expect(cipher.decrypt('{"enabled":true}', "legacy")).rejects.toThrow("Unsupported")
 await expect(deserializeConfig('{"enabled":true}')).rejects.toThrow("Unsupported")
})
test("unavailable, missing or invalid keys never produce plaintext or reset the key", async () => {
 const unavailable = createConfigCipher({ get: async () => { throw new Error("sensitive system detail") }, set: async () => {} })
 await expect(unavailable.encrypt({ secret: "dummy" })).rejects.toThrow("keystore is unavailable")
 const encrypted = await createConfigCipher(memoryStore()).encrypt({ secret: "dummy" })
 const missingStore = memoryStore()
 await expect(createConfigCipher(missingStore).decrypt(encrypted.encrypted, encrypted.iv)).rejects.toThrow("key is missing")
 expect(missingStore.writes).toBe(0)
 const invalidStore = memoryStore("invalid")
 await expect(createConfigCipher(invalidStore).encrypt({ secret: "dummy" })).rejects.toThrow("key is invalid")
 expect(invalidStore.writes).toBe(0)
})
