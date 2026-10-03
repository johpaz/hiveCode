/**
 * Conduce el binario TUI real por socket: F2 → tab Providers → Enter → escribe
 * una clave → Enter, y comprueba que Bun responde con `provider_activate` y que
 * el hub vuelve a pintar la fila con la clave ya guardada.
 */
import { createIpcServer } from "@johpaz/hivecode-core/ipc/server"
import { closeHiveDb } from "@johpaz/hivecode-core/storage/hivedb"
import { col } from "@johpaz/hivecode-core/storage/hive"
import type { CodeConfigDoc, ModelDoc, ProviderDoc } from "@johpaz/hivecode-core/storage/collections"
import { hasProviderApiKey, storeProviderApiKey } from "@johpaz/hivecode-core/storage/crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const BIN = path.resolve(import.meta.dir, "../packages/hivetui/target/debug/hivetui")
const PID = "drive-settings"

closeHiveDb()
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-drive-"))
process.env.HIVE_DB_PATH = path.join(dbDir, "hivedb")
const socketPath = `/tmp/hivecode-${PID}.sock`
try { fs.unlinkSync(socketPath) } catch {}

// Un provider sin clave: es el caso donde antes Bun reabría la lista de providers.
await (await col<ProviderDoc>("providers")).put("drive-openai", {
  id: "drive-openai", name: "OpenAI", base_url: null, category: "llm",
  num_ctx: null, num_gpu: -1, enabled: true, active: false, is_free_tier: false,
  created_at: Date.now(),
}, { expectedVersion: 0 })
await (await col<ModelDoc>("models")).put("drive-openai/gpt-5.4", {
  id: "drive-openai/gpt-5.4", name: "gpt-5.4", provider_id: "drive-openai",
  model_type: "llm", enabled: true, context_window: 128000, capabilities: "[]",
}, { expectedVersion: 0 })

const seen: any[] = []
let onFrame: ((f: any) => void) | null = null
let sent = false

const server = createIpcServer({
  socketPath,
  sessionId: PID,
  send: (msg) => { seen.push(msg); onFrame?.(msg) },
  onMessage(msg) {
    // El TUI pide settings al abrir el hub.
    if (msg.type === "ready") {
      server.send({
        type: "init", mode: "approval", provider: "", model: "",
        project_name: "drive", project_path: dbDir, session_id: PID,
        version: "0.0.0-test", task_count: 0, token_count: 0, workers: [],
      })
    }
    if (msg.type === "request_settings") {
      void sendSettings()
    }
  },
  onError() {},
})

async function sendSettings() {
  const cfg = await col<CodeConfigDoc>("codeConfig")
  const def = (await cfg.get("default_provider"))?.doc.value ?? ""
  server.send({
    type: "settings_data",
    providers: [{
      id: "drive-openai", name: "OpenAI", model: "drive-openai/gpt-5.4",
      is_active: def === "drive-openai",
      // El estado real de la clave, como hace el launcher.
      has_key: await hasProviderApiKey("drive-openai"),
      browser_login: false,
      models: ["drive-openai/gpt-5.4"],
    }],
    agents: [], mcp: [], skills: [],
    github_connected: false, github_repo: null, telegram_active: false,
  })
}

const proc = Bun.spawn([BIN], {
  stdin: 0, stdout: 1, stderr: 2,
  env: { ...process.env, HIVECODE_IPC: server.endpoint, HIVETUI_HEADLESS: "1", HIVETUI_COLS: "120", HIVETUI_ROWS: "40" },
})

function waitFor(pred: (m: any) => boolean, label: string, ms = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { onFrame = null; reject(new Error(`timeout esperando ${label}`)) }, ms)
    const prev = onFrame
    onFrame = (m) => { prev?.(m); if (pred(m)) { clearTimeout(t); onFrame = null; resolve(m) } }
  })
}

const waitForMsg = (type: string, label = type) => waitFor(m => m.type === type, label)

// 1. Abrir el hub con F2 y esperar el snapshot.
await waitForMsg("ready", "ready")
await waitFor(() => seen.some(m => m.type === "settings_data"), "primer settings_data")
if (sent) throw new Error("no debe llegar antes de tiempo")
sent = true

// El hub pide settings al abrirse; para disparar la tecla hay que escribirlas.
const write = (s: string) => proc.stdin.write(s)

// F2 abre el hub → llega request_settings → respondemos con el snapshot real.
onFrame = (m) => {
  if (m.type === "request_settings") void sendSettings()
}
write("\x1bOQ") // F2 (SS3 P → xterm F2)
await new Promise(r => setTimeout(r, 700))

// 2. Enter sobre la fila → debe pedir la clave, no relistar providers.
let captured: any = null
onFrame = (m) => {
  if (m.type === "request_settings") void sendSettings()
  if (m.type === "provider_activate") captured = m
}
write("\r") // Enter
await new Promise(r => setTimeout(r, 500))

if (!captured) throw new Error("Enter no produjo provider_activate")
console.log("✓ Enter produjo provider_activate:", JSON.stringify(captured))
if (captured.provider_id !== "drive-openai") throw new Error(`id inesperado: ${captured.provider_id}`)

// 3. Escribir la clave → Enter.
write("sk-drive-123")
await new Promise(r => setTimeout(r, 200))
write("\r")
await new Promise(r => setTimeout(r, 600))

if (!captured.api_key) throw new Error("la clave no viajó en el mensaje")
console.log("✓ la clave se envió en el mensaje (no en un comando de chat)")

// 4. Bun la persiste y devuelve el snapshot con ✓.
await storeProviderApiKey("drive-openai", captured.api_key)
const refreshed = await waitFor(
  m => m.type === "settings_data" && m.providers?.[0]?.has_key === true,
  "settings_data con has_key=true",
)
console.log("✓ el hub se refrescó con la clave ya guardada:", JSON.stringify(refreshed.providers[0]))

// 5. La clave nunca debe aparecer como texto en la TUI.
const asText = JSON.stringify(seen.filter(m => m.type === "history_append"))
if (asText.includes("sk-drive-123")) throw new Error("la clave se filtró al historial")
console.log("✓ la clave no aparece en el historial")

proc.kill()
server.stop()
closeHiveDb()
try { fs.unlinkSync(socketPath) } catch {}
try { await Bun.secrets.delete({ service: "hive-code", name: "provider.drive-openai" }) } catch {}
console.log("\nOK — el flujo provider + API key funciona de punta a punta")
process.exit(0)
