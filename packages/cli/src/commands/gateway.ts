/**
 * Gateway Command - Refactored with Installation Adapters
 * 
 * Manages the Hive Gateway lifecycle using the installation adapter system.
 * Each installation method (Docker, Bun Global, Binary, etc.) is handled
 * by its specific adapter, providing clean separation of concerns.
 */

import { loadConfig, startGateway, logger, getHiveDir, initializeDatabase } from "@johpaz/hivecode-core";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync } from "node:fs";
import * as path from "node:path";
import { spawn, ChildProcess } from "child_process";

// Import adapter system
import {
  detectAdapter,
  type InstallationAdapter,
  type GatewayConfig,
  DEFAULT_GATEWAY_CONFIG,
  PORTS,
  getHiveDir as getAdapterHiveDir,
  findFreePort,
  waitForHttpPort,
  isDevMode,
  isChildProcess,
  getDistDir,
} from "../adapters";

const children: ChildProcess[] = [];

/**
 * Get the active installation adapter
 * Cached to avoid repeated detection
 */
let _adapter: InstallationAdapter | null = null;

async function getAdapter(): Promise<InstallationAdapter> {
  if (!_adapter) {
    _adapter = await detectAdapter({ verbose: false });
  }
  return _adapter;
}

/**
 * Reset the cached adapter (for testing or forced re-detection)
 */
export function resetAdapter(): void {
  _adapter = null;
}

// Hive-Code is terminal-only — no UI server

/**
 * Cleanup child processes on exit
 */
function cleanup() {
  if (children.length === 0) return;
  console.log("\n🧹 Limpiando procesos hijos...");
  for (const child of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
}

// Signal handlers
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

process.on("exit", () => {
  cleanup();
});

/**
 * Get default PID file path
 */
function getDefaultPidFile(): string {
  return path.join(getHiveDir(), "gateway.pid");
}

/**
 * Get log file path
 */
function getLogFile(): string {
  return path.join(getHiveDir(), "logs", "gateway.log");
}

/**
 * Get PID file path from config or default
 */
async function getPidFile(): Promise<string> {
  try {
    const config = await loadConfig();
    return config.gateway?.pidFile || getDefaultPidFile();
  } catch {
    return getDefaultPidFile();
  }
}

/**
 * Ensure log directory exists
 */
function ensureLogDir(): void {
  const logDir = path.dirname(getLogFile());
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

// Hive-Code is terminal-only — no browser auto-open

/**
 * Check if gateway is running using the adapter
 */
async function isRunning(): Promise<boolean> {
  try {
    // Try adapter first
    const adapter = await getAdapter();
    const adapterRunning = await adapter.isRunning();
    if (adapterRunning) {
      return true;
    }
  } catch {
    // Adapter check failed, fall through to PID check
  }


}

/**
 * Wait for gateway port to be ready
 */
async function waitForPort(port: number, timeout: number = 30000): Promise<boolean> {
  return waitForHttpPort(port, "/health", timeout);
}


/**
 * Start command - main entry point
 */
export async function start(flags: string[]): Promise<void> {
  const daemon = flags.includes("--daemon");
  const skipCheck = flags.includes("--skip-check");
  const isDev = isDevMode();
  const isChild = isChildProcess();

  // Detect and set adapter
  const adapter = await getAdapter();
  const config = await adapter.getConfig();

  // Skip onboarding check if running as child process
  const isGatewayChild = process.env.HIVE_GATEWAY_CHILD === "1";

  if (!skipCheck && await isRunning()) {
    console.log("⚠️  Hive Gateway ya está corriendo");
    return;
  }

  // Load core config for logger settings
  try {
    const coreConfig = await loadConfig();
    if (coreConfig.logging?.level) {
      logger.setLevel(coreConfig.logging.level);
    }
  } catch {
    // Use default logger settings
  }

  // Show banner only if not running as child process
  if (!isGatewayChild) {
    console.log(`
 ╔═══════════════════════════════════════════╗
 ║                                           ║
 ║   🐝  Hive-Code — Multi-AI Coding Tool   ║
 ║                                           ║
 ║   ⬡  Architecture  ⬡  Backend            ║
 ║   ⬡  Frontend      ⬡  Security           ║
 ║   ⬡  Test          ⬡  DevOps             ║
 ║                                           ║
 ║   Terminal-only · SQLite WAL · Bun Workers║
 ╚═══════════════════════════════════════════╝

📦 Installation: ${adapter.name}
`);
  }

  // Handle daemon mode
  if (daemon) {
    ensureLogDir();
    const logFile = getLogFile();
    const child = spawn(process.execPath, [process.argv[1] || "", "start", "--skip-check"], {
      detached: true,
      stdio: ["ignore", openSync(logFile, "a"), openSync(logFile, "a")],
      env: { ...process.env, HIVE_GATEWAY_CHILD: "1" },
    });
    child.unref();
    writeFileSync(await getPidFile(), child.pid?.toString() || "");
    console.log(`✅ Hive Gateway iniciado en modo daemon (PID: ${child.pid})`);
    console.log(`   Logs: ${logFile}`);
    return;
  }

  // Development mode
  if (isDev) {
    await handleDevMode(adapter, config.gateway, daemon);
    return;
  }

  // Production mode
  await handleProductionMode(adapter, config.gateway, daemon);
}

/**
 * Handle development mode startup — terminal only, no Vite, no browser
 */
async function handleDevMode(
  _adapter: InstallationAdapter,
  gatewayConfig: GatewayConfig,
  daemon: boolean
): Promise<void> {
  if (isChildProcess()) {
    // Child process: just start gateway
    logger.info("Starting Gateway server (child process)...");
    const coreConfig = await loadConfig();
    await startGateway(coreConfig);
    return;
  }

  // Spawn Gateway child process
  const spawnGateway = (): ReturnType<typeof spawn> => {
    const gw = spawn(process.execPath, [process.argv[1] || "", "start", "--skip-check"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HIVE_DEV: "true", HIVE_GATEWAY_CHILD: "1" },
    });

    gw.stdout?.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) console.log(`[Gateway] ${line}`);
      }
    });

    gw.stderr?.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) console.error(`[Gateway] ${line}`);
      }
    });

    gw.on("error", (error) => {
      console.error(`❌ Error iniciando Gateway: ${error.message}`);
    });

    gw.on("exit", (code) => {
      if (code === 0) {
        console.log("[Gateway] Reiniciando tras setup...");
        const newGw = spawnGateway();
        const idx = children.indexOf(gw);
        if (idx !== -1) children.splice(idx, 1, newGw);
      }
    });

    if (!daemon) {
      children.push(gw);
    } else {
      gw.unref();
    }

    return gw;
  };

  const gatewayProcess = spawnGateway();

  // Wait for gateway
  console.log("⏳ Esperando Gateway...");
  const gatewayReady = await waitForHttpPort(gatewayConfig.port, "/health", 30000);

  if (!gatewayReady) {
    console.error("⚠️  Gateway no respondió a tiempo");
    return;
  }

  await Bun.sleep(200);

  console.log("✅ Gateway listo\n");

  console.log(`
╔════════════════════════════════════════╗
║  🐝  Hive-Code — Modo Desarrollo       ║
╠════════════════════════════════════════╣
║  API:       http://127.0.0.1:${gatewayConfig.port.toString().padEnd(5)}║
║  WebSocket: ws://127.0.0.1:${gatewayConfig.port.toString().padEnd(5)}ws ║
╠════════════════════════════════════════╣
║  Terminal-only — no UI, no browser     ║
╚════════════════════════════════════════╝
`);

  if (!daemon) {
    await new Promise(() => { }); // Infinite wait
  }
}

/**
 * Handle production mode startup — terminal only
 */
async function handleProductionMode(
  _adapter: InstallationAdapter,
  gatewayConfig: GatewayConfig,
  _daemon: boolean
): Promise<void> {
  if (isChildProcess()) {
    const coreConfig = await loadConfig();
    await startGateway(coreConfig);
    return;
  }

  // Spawn Gateway child process
  const spawnGatewayProd = (): ReturnType<typeof spawn> => {
    const scriptPath = process.argv[1] || "";
    const isDockerContainer = process.env.HIVE_UI_DIR === "/app/ui";
    const isBunScript = scriptPath.endsWith(".js") || scriptPath.endsWith(".ts");

    let command: string;
    let args: string[];

    if (isDockerContainer) {
      command = "/app/hive-server";
      args = ["start", "--skip-check"];
    } else if (isBunScript) {
      command = process.execPath;
      args = [scriptPath, "start", "--skip-check"];
    } else {
      command = process.execPath;
      args = ["start", "--skip-check"];
    }

    const gw = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HIVE_GATEWAY_CHILD: "1", NO_BROWSER: "1", ...(getDistDir() ? { HIVE_DIST_DIR: getDistDir()! } : {}) },
    });

    gw.stdout?.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) console.log(`[Gateway] ${line}`);
      }
    });

    gw.stderr?.on("data", (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) console.error(`[Gateway] ${line}`);
      }
    });

    gw.on("error", (error) => {
      console.error(`❌ Error iniciando Gateway: ${error.message}`);
    });

    gw.on("exit", (code) => {
      if (code === 0) {
        console.log("[Gateway] Reiniciando tras setup...");
        const newGw = spawnGatewayProd();
        const idx = children.indexOf(gw);
        if (idx !== -1) children.splice(idx, 1, newGw);
      }
    });

    children.push(gw);
    return gw;
  };

  spawnGatewayProd();

  console.log(`
╔════════════════════════════════════════╗
║  🐝  Hive-Code — Modo Producción       ║
╠════════════════════════════════════════╣
║  API:       http://127.0.0.1:${gatewayConfig.port.toString().padEnd(5)}║
║  WebSocket: ws://127.0.0.1:${gatewayConfig.port.toString().padEnd(5)}ws ║
╠════════════════════════════════════════╣
║  Terminal-only — no UI, no browser     ║
╚════════════════════════════════════════╝
`);
}

/**
 * Stop command
 */
export async function stop(): Promise<void> {
  const adapter = await getAdapter();

  // Try adapter stop first
  try {
    if (await adapter.isRunning()) {
      await adapter.stop();
      console.log("✅ Hive Gateway detenido");
      return;
    }
  } catch {
    // Adapter stop failed, fall through to manual stop
  }

  // Fallback to manual PID-based stop
  if (!(await isRunning())) {
    console.log("⚠️  Hive Gateway no está corriendo");
    return;
  }

  const pidFile = await getPidFile();
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");
    unlinkSync(pidFile);
    console.log("✅ Hive Gateway detenido");
  } catch (e) {
    console.error("❌ Error deteniendo el Gateway:", e);
  }
}

/**
 * Status command
 */
export async function status(flags: string[]): Promise<void> {
  const adapter = await getAdapter();
  const adapterConfig = await adapter.getConfig();
  const running = await adapter.isRunning();
  const hiveDir = getHiveDir();

  console.log("🐝 Hive Code Status\n");

  const coreConfig = await loadConfig();
  const pid = await adapter.getPid();

  console.log(`Estado:        ${running ? "✅ Corriendo" : "⏹️  Detenido"}`);
  if (running && pid) {
    console.log(`PID:           ${pid}`);
  }
  console.log(`Installation:  ${adapter.name} (${adapterConfig.type})`);
  console.log(`Puerto:        ${adapterConfig.gateway.port}`);
  console.log(`Host:          ${adapterConfig.gateway.host}`);

  const provider = coreConfig.models?.defaultProvider || "no configurado";
  const model = (coreConfig.models as any)?.defaults?.[provider] || (coreConfig.models as any)?.defaults?.default || "no configurado";
  console.log(`Modelo:        ${provider} / ${model}`);
  console.log(`Home:          ${hiveDir}`);
  console.log(`Logs:          ${getLogFile()}`);

  if (flags.includes("--json")) {
    console.log("\n" + JSON.stringify({
      running,
      pid,
      type: adapterConfig.type,
      config: adapterConfig,
    }, null, 2));
  }
}

/**
 * Reload command
 */
export async function reload(): Promise<void> {
  if (!(await isRunning())) {
    console.log("⚠️  Hive Gateway no está corriendo");
    return;
  }

  const pidFile = await getPidFile();
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGHUP");
    console.log("✅ Configuración recargada");
  } catch (e) {
    console.error("❌ Error recargando configuración:", e);
  }
}
