import {
  getGatewayToken,
  rotateGatewayToken,
} from "../../../core/src/gateway/helpers/gateway-token";
import { getProviderApiKey, rotateProviderApiKey, hasProviderApiKey } from "../../../core/src/storage/crypto";

const SERVICE = "hive-code";

export async function secrets(subcommand?: string, args?: string[]): Promise<void> {
  switch (subcommand) {
    case "list": {
      console.log("🔐 HiveCode Secrets (presence only):");
      try {
        const gateway = await getGatewayToken();
        console.log(`  gateway-token: ${gateway ? "✅ present" : "❌ missing"}`);
      } catch { console.log(`  gateway-token: ❌ error reading`); }

      try {
        const providers = ["openai", "anthropic", "groq", "mistral", "gemini", "ollama", "local-llama"];
        for (const p of providers) {
          const has = await hasProviderApiKey(p);
          console.log(`  provider.${p}: ${has ? "✅ present" : "❌ missing"}`);
        }
      } catch (e) {
        console.log(`  providers: ❌ error reading (${(e as Error).message})`);
      }
      break;
    }

    case "set": {
      const name = args?.[0];
      if (!name) { console.log("Usage: hivecode secret set <name>"); return; }
      const value = await readPassword(`Enter value for ${name}: `);
      try {
        await Bun.secrets.set({ service: SERVICE, name, value });
        console.log(`✅ Secret '${name}' saved to Bun.secrets.`);
      } catch (e) {
        console.log(`❌ Failed to save secret: ${(e as Error).message}`);
      }
      break;
    }

    case "delete": {
      const name = args?.[0];
      if (!name) { console.log("Usage: hivecode secret delete <name>"); return; }
      try {
        await Bun.secrets.delete({ service: SERVICE, name });
        console.log(`✅ Secret '${name}' deleted.`);
      } catch (e) {
        console.log(`❌ Failed to delete secret: ${(e as Error).message}`);
      }
      break;
    }

    case "rotate": {
      const name = args?.[0];
      if (!name) { console.log("Usage: hivecode secret rotate <name>"); return; }

      if (name === "gateway-token") {
        const newToken = await rotateGatewayToken();
        console.log(`✅ Gateway token rotated. New token (first 8 chars): ${newToken.slice(0, 8)}...`);
        return;
      }

      if (name.startsWith("provider.")) {
        const providerId = name.slice("provider.".length);
        const newValue = await readPassword(`Enter NEW API key for ${providerId}: `);
        await rotateProviderApiKey(providerId, newValue);
        console.log(`✅ Provider '${providerId}' API key rotated.`);
        return;
      }

      const newValue = await readPassword(`Enter NEW value for ${name}: `);
      try {
        await Bun.secrets.set({ service: SERVICE, name, value: newValue });
        console.log(`✅ Secret '${name}' rotated.`);
      } catch (e) {
        console.log(`❌ Failed to rotate secret: ${(e as Error).message}`);
      }
      break;
    }

    default:
      console.log("Usage:")
      console.log("  hivecode secret list                  Listar secrets (solo nombres)")
      console.log("  hivecode secret set <name>            Establecer secret")
      console.log("  hivecode secret delete <name>         Eliminar secret")
      console.log("  hivecode secret rotate <name>         Rotar secret")
      console.log("")
      console.log("Ejemplos:")
      console.log("  hivecode secret rotate gateway-token")
      console.log("  hivecode secret rotate provider.openai")
  }
}

async function readPassword(prompt: string): Promise<string> {
  console.log(prompt);
  const buf = new Uint8Array(1024);
  const n = (Bun.stdin as any).read(buf);
  if (n === null) return "";
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}
