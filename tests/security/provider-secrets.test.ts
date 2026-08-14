import { describe, expect, it } from "bun:test"
import { decryptApiKey, encryptApiKey } from "@johpaz/hivecode-core/storage/crypto"

describe("provider secret storage contract", () => {
  it("rejects serializing an API key into document storage", () => {
    expect(() => encryptApiKey("secret-value")).toThrow("storeProviderApiKey")
  })

  it("rejects reading legacy serialized API key material", () => {
    expect(() => decryptApiKey("legacy-value", "legacy")).toThrow("getProviderApiKey")
  })
})
