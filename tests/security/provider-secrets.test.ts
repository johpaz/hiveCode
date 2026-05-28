import { describe, expect, it } from "bun:test"
import { decryptApiKey, encryptApiKey } from "@johpaz/hivecode-core/storage/crypto"

describe("provider secret storage contract", () => {
  it("rejects serializing an API key for SQLite storage", () => {
    expect(() => encryptApiKey("secret-value")).toThrow("storeProviderApiKey")
  })

  it("rejects reading legacy API key material from SQLite", () => {
    expect(() => decryptApiKey("legacy-value", "legacy")).toThrow("getProviderApiKey")
  })
})
