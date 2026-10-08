import { col } from "../storage/hive";
import { getHiveDbPath } from "../storage/hivedb";
import { listCatalogProviders } from "./provider-catalog-read";
import { SUPPORTED_LLM_PROVIDERS } from "./provider-capabilities";

export interface DiagnosticCheck { name: string; status: "pass" | "warn" | "fail"; message: string; detail?: string }
export async function runtimeDiagnostics(): Promise<DiagnosticCheck[]> {
  const version = Bun.version.split(".").map(Number);
  const minimum = [1, 4, 2];
  let supported = true;
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) { supported = version[index]! > minimum[index]!; break; }
  }
  const checks: DiagnosticCheck[] = [{ name: "Bun runtime", status: supported ? "pass" : "warn", message: `v${Bun.version}`, detail: supported ? undefined : "Requiere Bun >= 1.4.2" }];
  try {
    await col("meta");
    checks.push({ name: "HiveDB", status: "pass", message: "Disponible", detail: getHiveDbPath() });
    const config = await (await col<{value: string}>("codeConfig")).get("default_provider");
    const providers = (await listCatalogProviders()).filter(provider => SUPPORTED_LLM_PROVIDERS.has(provider.id)
      && provider.enabled && (provider.active || provider.id === config?.doc.value));
    checks.push({ name: "Providers LLM", status: providers.length ? "pass" : "warn", message: providers.map(provider => provider.name).join(", ") || "Ningún provider configurado" });
  } catch (error) {
    checks.push({ name: "HiveDB", status: "fail", message: "No disponible", detail: (error as Error).message });
  }
  return checks;
}
export async function renderRuntimeDiagnostics(): Promise<string> {
  return (await runtimeDiagnostics()).map(check => `${check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "×"} ${check.name}: ${check.message}${check.detail ? ` · ${check.detail}` : ""}`).join("\n");
}
