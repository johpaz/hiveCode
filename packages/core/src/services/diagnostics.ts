/**
 * What `hivecode doctor` and `/doctor` report. One implementation for both, so the TUI and the shell
 * never disagree about whether the setup works.
 *
 * Every check answers three questions: is it fine, what exactly is wrong, and what to do about it
 * (`fix`). A check that throws is reported as a failed check, never as a crashed doctor.
 */
import { statfsSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { col, fromIndexable } from "../storage/hive";
import { findLegacyHiveDb, getHiveDbPath } from "../storage/hivedb";
import { listCatalogModels, listCatalogProviders } from "./provider-catalog-read";
import { SUPPORTED_LLM_PROVIDERS } from "./provider-capabilities";
import { getProviderApiKey } from "../storage/crypto";
import type { AgentDoc, ChannelDoc, CodeConfigDoc, CodeTaskDoc, LearningProposalDoc, McpServerDoc, SkillDoc } from "../storage/collections";

export type DiagnosticStatus = "pass" | "warn" | "fail";
export type DiagnosticSection = "Sistema" | "Modelo" | "Agentes" | "Proyecto" | "Canales" | "Estado";

export interface DiagnosticCheck {
  name: string;
  status: DiagnosticStatus;
  message: string;
  detail?: string;
  /** What to do about it, in one line. Only present when something is not fine. */
  fix?: string;
  section?: DiagnosticSection;
}

export interface DiagnosticsOptions {
  /** Project directory the doctor looks at (git, worktrees). */
  cwd?: string;
  /** Skip the checks that spawn processes or touch the disk. */
  quick?: boolean;
}

const MIN_BUN = [1, 4, 2];
const CORE_PROFILES = ["bee", "planner", "scout", "builder", "verifier", "spider"];
const MB = 1024 * 1024;

async function guard(section: DiagnosticSection, name: string, run: () => Promise<DiagnosticCheck[]>): Promise<DiagnosticCheck[]> {
  try {
    return (await run()).map(check => ({ section, ...check }));
  } catch (error) {
    return [{ section, name, status: "fail", message: "No se pudo comprobar", detail: (error as Error).message }];
  }
}

async function config(key: string): Promise<string | null> {
  return (await (await col<CodeConfigDoc>("codeConfig")).get(key))?.doc.value ?? null;
}

async function git(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { ok: code === 0, out: out.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

// ── Sistema ──────────────────────────────────────────────────────────────────

async function systemChecks(quick: boolean): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const version = Bun.version.split(".").map(Number);
  let supported = true;
  for (let i = 0; i < MIN_BUN.length; i++) {
    if (version[i] !== MIN_BUN[i]) { supported = version[i]! > MIN_BUN[i]!; break; }
  }
  checks.push({
    name: "Bun", status: supported ? "pass" : "warn", message: `v${Bun.version}`,
    ...(supported ? {} : { detail: `Requiere Bun >= ${MIN_BUN.join(".")}`, fix: "bun upgrade" }),
  });

  await col("meta");
  checks.push({ name: "HiveDB", status: "pass", message: "Disponible", detail: getHiveDbPath() });
  const legacy = findLegacyHiveDb();
  if (legacy) {
    checks.push({
      name: "HiveDB antigua", status: "warn", message: "Hay una base de datos en este directorio que no se está usando",
      detail: legacy, fix: "hivecode doctor --migrate-db",
    });
  }

  if (!quick) {
    // The temp dir holds task worktrees and test scratch; a full or over-quota one fails in confusing ways.
    const dir = tmpdir();
    try {
      const stats = statfsSync(dir);
      const freeMb = Math.floor((Number(stats.bavail) * Number(stats.bsize)) / MB);
      const status: DiagnosticStatus = freeMb < 100 ? "fail" : freeMb < 1024 ? "warn" : "pass";
      checks.push({
        name: "Disco", status, message: `${freeMb >= 1024 ? `${(freeMb / 1024).toFixed(1)} GB` : `${freeMb} MB`} libres en ${dir}`,
        ...(status === "pass" ? {} : { fix: "Libera espacio: /task cleanup y borra hivecode-* de /tmp" }),
      });
    } catch { /* statfs unavailable on this platform: the write test below still tells the truth */ }
    try {
      const scratch = mkdtempSync(path.join(dir, "hive-doctor-"));
      writeFileSync(path.join(scratch, "probe"), "ok");
      rmSync(scratch, { recursive: true, force: true });
      checks.push({ name: "Escritura en /tmp", status: "pass", message: "Se puede escribir" });
    } catch (error) {
      checks.push({
        name: "Escritura en /tmp", status: "fail", message: "No se puede escribir en el directorio temporal",
        detail: (error as Error).message, fix: "Libera espacio o cuota: los worktrees de las tareas viven ahí",
      });
    }
  }
  return checks;
}

// ── Modelo ───────────────────────────────────────────────────────────────────

async function modelChecks(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const defaultProvider = await config("default_provider");
  if (!defaultProvider) {
    return [{
      // First run, not a broken install: warn, so `doctor` still exits 0 on a fresh machine.
      name: "Provider", status: "warn", message: "Ningún provider configurado",
      fix: "F2 → Providers (o /provider add) y pega tu API key",
    }];
  }

  const catalog = await listCatalogProviders();
  const known = catalog.find(p => p.id === defaultProvider);
  const label = known?.name ?? defaultProvider;
  if (!SUPPORTED_LLM_PROVIDERS.has(defaultProvider)) {
    checks.push({ name: "Provider", status: "warn", message: `${label} (compatible OpenAI)`, detail: "No es uno de los providers con adaptador propio" });
  } else {
    checks.push({ name: "Provider", status: "pass", message: label });
  }

  let key: string | null = null;
  try {
    key = await getProviderApiKey(defaultProvider);
  } catch {
    checks.push({
      name: "Llavero", status: "fail", message: "El llavero del sistema no está disponible",
      fix: "Instala/activa un servicio de secretos (libsecret en Linux) para guardar las API keys",
    });
  }
  if (key !== null || !checks.some(c => c.name === "Llavero")) {
    checks.push(key
      ? { name: "API key", status: "pass", message: `Guardada para ${label}` }
      : { name: "API key", status: "fail", message: `Falta la API key de ${label}`, fix: "F2 → Providers → elige el provider → Enter y pega la key" });
  }

  const model = await config(`provider_model_${defaultProvider}`);
  if (!model) {
    checks.push({ name: "Modelo", status: "warn", message: "Sin modelo elegido: se usará el predeterminado del provider", fix: "F2 → Modelos" });
  } else {
    const models = await listCatalogModels(defaultProvider).catch(() => []);
    const inCatalog = models.length === 0 || models.some(m => m.id === model);
    checks.push(inCatalog
      ? { name: "Modelo", status: "pass", message: model }
      : { name: "Modelo", status: "warn", message: `${model} no está en el catálogo de ${label}`, fix: "F2 → Modelos y elige uno de la lista" });
  }

  const bee = (await (await col<AgentDoc>("agents")).get("bee"))?.doc;
  if (bee?.model_selection === "custom") {
    const beeProvider = fromIndexable(bee.provider_id);
    const beeModel = fromIndexable(bee.model_id);
    let beeKey: string | null = null;
    try { beeKey = beeProvider ? await getProviderApiKey(beeProvider) : null; } catch { /* reported above */ }
    checks.push(beeProvider && beeKey
      ? { name: "Modelo de BEE", status: "pass", message: `${beeProvider} · ${beeModel} (propio)` }
      : { name: "Modelo de BEE", status: "fail", message: `BEE usa ${beeProvider ?? "?"} · ${beeModel ?? "?"} pero ese provider no tiene API key`, fix: "F2 → Agentes → BEE, o vuelve a «heredar»" });
  } else {
    checks.push({ name: "Modelo de BEE", status: "pass", message: `${defaultProvider}${model ? ` · ${model}` : ""} (heredado)` });
  }

  return checks;
}

// ── Agentes ──────────────────────────────────────────────────────────────────

async function agentChecks(): Promise<DiagnosticCheck[]> {
  const agents = (await (await col<AgentDoc>("agents")).scan()).map(e => e.doc);
  const missing = CORE_PROFILES.filter(id => !agents.some(a => a.id === id));
  const disabled = CORE_PROFILES.filter(id => agents.some(a => a.id === id && !a.enabled));
  const checks: DiagnosticCheck[] = [];
  if (missing.length) {
    checks.push({ name: "Perfiles", status: "fail", message: `Faltan perfiles: ${missing.join(", ")}`, fix: "Reinicia hivecode: los perfiles base se recrean al arrancar" });
  } else if (disabled.length) {
    checks.push({ name: "Perfiles", status: "warn", message: `Desactivados: ${disabled.join(", ")}`, fix: "/agent configure <perfil>" });
  } else {
    checks.push({ name: "Perfiles", status: "pass", message: `${CORE_PROFILES.length} perfiles base: ${CORE_PROFILES.join(" · ")}` });
  }
  const skills = (await (await col<SkillDoc>("skills")).scan()).length;
  checks.push(skills > 0
    ? { name: "Skills", status: "pass", message: `${skills} cargadas` }
    : { name: "Skills", status: "warn", message: "Ninguna skill registrada", fix: "Reinicia hivecode para sembrar las skills incluidas" });
  const mcp = (await (await col<McpServerDoc>("mcpServers")).scan()).map(e => e.doc);
  checks.push({ name: "MCP", status: "pass", message: mcp.length ? `${mcp.filter(s => s.enabled).length}/${mcp.length} servidores activos` : "Sin servidores (opcional)" });
  return checks;
}

// ── Proyecto ─────────────────────────────────────────────────────────────────

async function projectChecks(cwd: string): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const version = await git(cwd, "--version");
  if (!version.ok) {
    return [{ name: "git", status: "fail", message: "git no está instalado", fix: "Instala git: las tareas con cambios se aíslan en worktrees" }];
  }
  const inside = await git(cwd, "rev-parse", "--is-inside-work-tree");
  if (!inside.ok) {
    checks.push({ name: "Repositorio", status: "warn", message: `${cwd} no es un repositorio git`, fix: "git init — sin git las tareas no se aíslan ni se pueden revertir" });
    return checks;
  }
  checks.push({ name: "Repositorio", status: "pass", message: cwd });

  const listed = await git(cwd, "worktree", "list", "--porcelain");
  const stale = listed.out.split(/\n\n+/).filter(block => /^branch refs\/heads\/hivecode\/(task|swarm)-/m.test(block)).length;
  checks.push(stale
    ? { name: "Worktrees de tareas", status: "warn", message: `${stale} sin limpiar`, fix: "/task cleanup (con --force si tienen trabajo sin integrar)" }
    : { name: "Worktrees de tareas", status: "pass", message: "Ninguno pendiente" });

  // Workers run commands with a minimal PATH; if bun is not on it they install their own copy from npm.
  try {
    const { buildSandboxEnv } = await import("../tools/cli/index");
    const bun = Bun.which("bun");
    const onPath = !bun || (buildSandboxEnv(cwd).PATH ?? "").split(":").includes(path.dirname(bun));
    checks.push(onPath
      ? { name: "bun en el shell de los workers", status: "pass", message: bun ? `Disponible (${path.dirname(bun)})` : "Ejecutable propio" }
      : { name: "bun en el shell de los workers", status: "warn", message: "Los workers no ven bun", fix: "Actualiza hivecode" });
  } catch { /* the shell tool is optional in some builds */ }
  return checks;
}

// ── Canales ──────────────────────────────────────────────────────────────────

async function channelChecks(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const github = await config("github_token");
  checks.push({ name: "GitHub", status: "pass", message: github ? "Conectado" : "Sin conectar (opcional)" });

  const channels = (await (await col<ChannelDoc>("channels")).scan()).map(e => e.doc);
  const telegram = channels.find(c => c.type === "telegram");
  // The seeded channel row is enabled but untouched; only a channel somebody configured must have its token.
  if (!telegram?.enabled || !["configured", "connected", "error"].includes(telegram.status)) {
    checks.push({ name: "Telegram", status: "pass", message: "Sin conectar (opcional)" });
    return checks;
  }
  let token: string | null = null;
  try { token = await Bun.secrets.get({ service: "hive-code", name: "telegram.bot_token" }); } catch { /* keystore reported elsewhere */ }
  if (!token) {
    checks.push({ name: "Telegram", status: "fail", message: "Activado pero sin token del bot", fix: "F2 → Telegram → Conectar y pega el token de @BotFather" });
  } else if (telegram.status === "error") {
    checks.push({ name: "Telegram", status: "warn", message: "El bot no pudo arrancar", detail: "Token revocado o sin red", fix: "F2 → Telegram → Conectar con un token nuevo" });
  } else {
    checks.push({ name: "Telegram", status: "pass", message: telegram.status === "connected" ? "Conectado" : `Configurado (${telegram.status})` });
  }
  return checks;
}

// ── Estado ───────────────────────────────────────────────────────────────────

async function stateChecks(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const tasks = (await (await col<CodeTaskDoc>("codeTasks")).scan()).map(e => e.doc);
  const open = tasks.filter(t => t.status === "running" || t.status === "planning" || t.status === "pending");
  checks.push(open.length
    ? { name: "Tareas abiertas", status: "warn", message: `${open.length} sin terminar`, detail: open.slice(0, 3).map(t => `${t.status}: ${String(t.description).slice(0, 60)}`).join("\n"), fix: "Si no hay ninguna en curso, se reconcilian al reiniciar; /task cancel para cerrarlas" }
    : { name: "Tareas abiertas", status: "pass", message: "Ninguna" });
  try {
    const pending = (await (await col<LearningProposalDoc>("learningProposals")).findBy("status", "pending")).length;
    checks.push(pending
      ? { name: "Propuestas de aprendizaje", status: "warn", message: `${pending} pendientes de revisión`, fix: "/narrative show" }
      : { name: "Propuestas de aprendizaje", status: "pass", message: "Ninguna pendiente" });
  } catch { /* table not created until the first run */ }
  return checks;
}

export async function runtimeDiagnostics(options: DiagnosticsOptions = {}): Promise<DiagnosticCheck[]> {
  const cwd = options.cwd ?? process.cwd();
  const quick = options.quick === true;
  const groups = await Promise.all([
    guard("Sistema", "Sistema", () => systemChecks(quick)),
    guard("Modelo", "Modelo", modelChecks),
    guard("Agentes", "Agentes", agentChecks),
    guard("Proyecto", "Proyecto", () => (quick ? Promise.resolve([]) : projectChecks(cwd))),
    guard("Canales", "Canales", channelChecks),
    guard("Estado", "Estado", stateChecks),
  ]);
  return groups.flat();
}

export function summarizeDiagnostics(checks: DiagnosticCheck[]): { pass: number; warn: number; fail: number } {
  return {
    pass: checks.filter(c => c.status === "pass").length,
    warn: checks.filter(c => c.status === "warn").length,
    fail: checks.filter(c => c.status === "fail").length,
  };
}

/** Plain text, grouped by section, with the fix under every problem. Used by `/doctor`. */
export async function renderRuntimeDiagnostics(options: DiagnosticsOptions = {}): Promise<string> {
  const checks = await runtimeDiagnostics(options);
  const lines: string[] = [];
  let section: string | undefined;
  for (const check of checks) {
    if (check.section !== section) {
      section = check.section;
      lines.push("", `── ${section} ──`);
    }
    const symbol = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    lines.push(`${symbol} ${check.name}: ${check.message}`);
    if (check.detail && check.status !== "pass") lines.push(...check.detail.split("\n").map(line => `    ${line}`));
    else if (check.detail) lines.push(`    ${check.detail}`);
    if (check.fix) lines.push(`    → ${check.fix}`);
  }
  const { pass, warn, fail } = summarizeDiagnostics(checks);
  lines.push("", fail ? `${fail} error(es), ${warn} aviso(s), ${pass} correctos` : warn ? `${warn} aviso(s), ${pass} correctos: funciona, con cosas que revisar` : `Todo en orden (${pass} comprobaciones)`);
  return lines.join("\n").trim();
}
