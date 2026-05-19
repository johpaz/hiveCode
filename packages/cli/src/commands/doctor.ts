import { getGatewayToken } from "../../../core/src/gateway/helpers/gateway-token";
import { hasProviderApiKey } from "../../../core/src/storage/crypto";
import { loadTlsCredentials, shouldRenewCert } from "../../../core/src/utils/tls";

export async function doctor(): Promise<void> {
  let issues = 0;
  let warnings = 0;

  console.log("🔍 HiveCode Doctor — Security Checklist\n");

  // 1. Gateway Token
  try {
    const token = await getGatewayToken();
    if (token) {
      console.log("✅ Gateway token: present in Bun.secrets");
    } else {
      console.log("❌ Gateway token: MISSING");
      issues++;
    }
  } catch (e) {
    console.log(`❌ Gateway token: ERROR — ${(e as Error).message}`);
    issues++;
  }

  // 2. TLS Credentials
  try {
    const creds = await loadTlsCredentials();
    if (creds) {
      const needsRenew = await shouldRenewCert();
      console.log(`✅ TLS credentials: present (${needsRenew ? "⚠️ needs renewal" : "valid"})`);
      if (needsRenew) warnings++;
    } else {
      console.log("⚠️ TLS credentials: not configured (run hivecode init)");
      warnings++;
    }
  } catch (e) {
    console.log(`❌ TLS credentials: ERROR — ${(e as Error).message}`);
    issues++;
  }

  // 3. Provider API Keys
  const providers = ["openai", "anthropic", "groq", "mistral", "gemini", "ollama", "local-llama"];
  let providerCount = 0;
  for (const p of providers) {
// 6. Check for secrets in SQLite (should be empty)
  try {
      if (await hasProviderApiKey(p)) providerCount++;
    } catch { /* ignore */ }
  }
  if (providerCount > 0) {
    console.log(`✅ Provider API keys: ${providerCount} configured in Bun.secrets`);
  } else {
    console.log("⚠️ Provider API keys: none configured in Bun.secrets");
    warnings++;
  }

  // 4. Check for secrets in environment (deprecated — must use Bun.secrets)
  const envSecrets = Object.keys(process.env).filter(k =>
    /API_KEY|SECRET|TOKEN|PRIVATE/.test(k) && k.startsWith("HIVE_")
  );
  if (envSecrets.length > 0) {
    console.log(`❌ INSECURE: Secrets detected in environment variables: ${envSecrets.join(", ")}`);
    console.log(`   Migrate to Bun.secrets: bunx @johpaz/hivecode secret set <name>`);
    issues += envSecrets.length;
  } else {
    console.log("✅ No secrets in environment variables");
  }

  // 5. Check for HIVE_AUTH_TOKEN specifically (removed in v1.1 — must use Bun.secrets)
  if (process.env.HIVE_AUTH_TOKEN) {
    console.log("❌ INSECURE: HIVE_AUTH_TOKEN detected in environment — this is no longer supported");
    console.log("   The gateway token is now managed exclusively via Bun.secrets");
    issues++;
  }
  // 6. Check for secrets in SQLite (should be empty)
  try {
    const { getDb } = await import("../../../core/src/storage/sqlite");
    const db = getDb();
    const rows = db.query("SELECT id FROM providers WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != ''").all() as Array<{ id: string }>;
    if (rows.length > 0) {
      console.log(`⚠️ SQLite contains ${rows.length} legacy API key(s): ${rows.map(r => r.id).join(", ")}`);
      warnings++;
    } else {
      console.log("✅ SQLite: no legacy API keys stored");
    }
  } catch (e) {
    console.log(`⚠️ SQLite check failed: ${(e as Error).message}`);
    warnings++;
  }

  // 6. Check lockfile
  try {
    const { existsSync } = await import("node:fs");
    if (existsSync("bun.lock")) {
      console.log("✅ Lockfile: bun.lock present");
    } else {
      console.log("⚠️ Lockfile: bun.lock missing");
      warnings++;
    }
  } catch {
    console.log("⚠️ Lockfile check failed");
    warnings++;
  }

  console.log("\n─────────────────────────────");
  if (issues === 0 && warnings === 0) {
    console.log("🎉 All checks passed! Your HiveCode installation is secure.");
  } else {
    console.log(`⚠️  ${issues} issue(s), ${warnings} warning(s) found.`);
    if (issues > 0) console.log("   Run the recommended fixes above.");
  }
}
