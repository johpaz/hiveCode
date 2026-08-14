import { Bot, GrammyError, InputFile, type Context } from "grammy";
import { BaseChannel, type ChannelConfig, type IncomingMessage, type OutboundMessage } from "./base.ts";
import { logger } from "../utils/logger.ts";
import { col } from "../storage/hive.ts";
import type { ChannelDoc, CodeConfigDoc, CodeNarrativeDoc, CodeTaskDoc, ProviderDoc } from "../storage/collections.ts";

export interface TelegramConfig extends ChannelConfig {
  botToken: string;
  groups?: boolean;
}

async function setChannelStatus(id: string, status: string): Promise<void> {
  const channels = await col<ChannelDoc>("channels");
  const entry = await channels.get(id);
  if (entry) await channels.put(id, { ...entry.doc, status }, { expectedVersion: entry.version });
}

async function getCodeConfig(key: string): Promise<string | null> {
  return (await (await col<CodeConfigDoc>("codeConfig")).get(key))?.doc.value ?? null;
}

async function setCodeConfig(key: string, value: string): Promise<void> {
  const config = await col<CodeConfigDoc>("codeConfig");
  const existing = await config.get(key);
  await config.put(key, { key, value, updated_at: Math.floor(Date.now() / 1000) }, { expectedVersion: existing?.version ?? 0 });
}

async function latestTask(statuses: string[]): Promise<CodeTaskDoc | null> {
  return (await (await col<CodeTaskDoc>("codeTasks")).scan())
    .map((entry) => entry.doc)
    .filter((task) => statuses.includes(task.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

async function recentTasks(limit: number): Promise<CodeTaskDoc[]> {
  return (await (await col<CodeTaskDoc>("codeTasks")).scan())
    .map((entry) => entry.doc)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

async function updateTaskStatus(id: string, status: CodeTaskDoc["status"]): Promise<void> {
  const tasks = await col<CodeTaskDoc>("codeTasks");
  const entry = await tasks.get(id);
  if (entry) await tasks.put(id, { ...entry.doc, status }, { expectedVersion: entry.version });
}

async function tokenTotal24h(): Promise<number> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return (await (await col<CodeTaskDoc>("codeTasks")).scan())
    .map((entry) => entry.doc)
    .filter((task) => new Date(task.created_at).getTime() > since)
    .reduce((sum, task) => sum + task.tokens_in + task.tokens_out, 0);
}

async function recentNarrative(limit: number, query?: string): Promise<CodeNarrativeDoc[]> {
  const needle = query?.toLowerCase();
  return (await (await col<CodeNarrativeDoc>("codeNarrative")).scan())
    .map((entry) => entry.doc)
    .filter((entry) => !needle || entry.entry.toLowerCase().includes(needle) || entry.coordinator.toLowerCase().includes(needle))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export class TelegramChannel extends BaseChannel {
  name = "telegram";
  accountId: string;
  config: TelegramConfig;

  private bot?: Bot;
  private log = logger.child("telegram");
  private chatIdCache: Map<string, number> = new Map();
  private messageIdCache: Map<string, number> = new Map();
  private recentlyProcessed: Map<number, number> = new Map();
  /** Pending approval callbacks keyed by "taskId:phaseId" */
  private approvalResolvers: Map<string, (decision: "approve" | "skip") => void> = new Map();
  /** Active approval timeouts keyed by "taskId:phaseId" */
  private approvalTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Chat ID to use for proactive notifications (set on first authorized message) */
  private notifyChatId: number | null = null;

  constructor(accountId: string, config: TelegramConfig) {
    super();
    this.accountId = accountId;
    this.config = {
      ...config,
      dmPolicy: config.dmPolicy ?? "open",
      allowFrom: config.allowFrom ?? [],
      enabled: config.enabled ?? true,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      this.log.warn("Telegram bot is already running, skipping start");
      return;
    }

    if (!this.config.botToken) {
      throw new Error("Telegram bot token not configured");
    }

    this.bot = new Bot(this.config.botToken);

    this.bot.on("message", async (ctx: Context) => {
      await this.handleTelegramMessage(ctx);
    });

    // Inline keyboard callbacks
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      try {
        if (data.startsWith("cancel_task:")) {
          const taskId = data.slice("cancel_task:".length);
          await updateTaskStatus(taskId, "cancelled");
          await ctx.editMessageText(`❌ Tarea <code>${taskId.slice(0, 8)}</code> cancelada.`, { parse_mode: "HTML" });
        } else if (data === "cancel_abort") {
          await ctx.editMessageText("↩️ Cancelación abortada.");
        } else if (data.startsWith("approve_phase:")) {
          const [, taskId, phaseId] = data.split(":");
          const resolver = this.approvalResolvers.get(`${taskId}:${phaseId}`);
          if (resolver) { resolver("approve"); this.approvalResolvers.delete(`${taskId}:${phaseId}`); }
          await ctx.editMessageText("✅ Fase aprobada — continuando...");
        } else if (data.startsWith("skip_phase:")) {
          const [, taskId, phaseId] = data.split(":");
          const resolver = this.approvalResolvers.get(`${taskId}:${phaseId}`);
          if (resolver) { resolver("skip"); this.approvalResolvers.delete(`${taskId}:${phaseId}`); }
          await ctx.editMessageText("⏭ Fase saltada.");
        } else if (data.startsWith("mode:")) {
          const newMode = data.slice("mode:".length);
          await setCodeConfig("active_mode", newMode);
          await ctx.editMessageText(`🎛 Modo cambiado a: <code>${newMode}</code>`, { parse_mode: "HTML" });
        }
      } catch (e) {
        this.log.error(`Callback error: ${(e as Error).message}`);
      }
      await ctx.answerCallbackQuery().catch(() => {});
    });

    // Note: edited_message intentionally NOT handled — editing a message
    // should not trigger a new agent response (was causing double sends).

    this.bot.catch((err: Error) => {
      this.log.error(`Telegram error: ${err.message}`);
    });

    this.bot.start({
      onStart: () => {
        this.running = true;
        this.log.info(`Telegram bot started: @${this.bot?.botInfo?.username ?? "unknown"}`);
        void setChannelStatus(this.accountId, "connected");
      },
    }).catch((error: Error) => {
      this.log.error(`Telegram bot error: ${error.message}`);
      this.running = false;
      void setChannelStatus(this.accountId, "error");
    });
  }

  private async handleTelegramMessage(ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message) return;

    const chatId = message.chat.id.toString();
    const userId = message.from?.id?.toString() ?? "unknown";
    const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
    const kind = isGroup ? "group" : "direct";
    const peerId = isGroup
      ? `${message.chat.id}:${message.from?.id ?? "unknown"}`
      : chatId;
    const messageId = message.message_id;

    if (message.from?.is_bot) {
      return;
    }

    // Deduplication: ignore message_ids already processed in the last 60 seconds
    const now = Date.now();
    if (this.recentlyProcessed.has(messageId)) {
      this.log.debug(`Duplicate message_id ${messageId} ignored`);
      return;
    }
    this.recentlyProcessed.set(messageId, now);
    // Clean up old entries (> 60s) to prevent unbounded growth
    for (const [id, ts] of this.recentlyProcessed) {
      if (now - ts > 60_000) this.recentlyProcessed.delete(id);
    }

    const text = message.text;
    const isCommand = text?.startsWith("/") ?? false;

    if (text === "/myid" || text?.startsWith("/myid@")) {
      await ctx.reply(
        `🆔 Tu Telegram ID es: <code>${userId}</code>\n\n` +
        `Para autorizarte, ejecuta:\n` +
        `<code>hive config set channels.telegram.accounts.default.allowFrom.+ "tg:${userId}"</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (text === "/start" || text?.startsWith("/start@")) {
      const agentName = "hivecode";
      await ctx.reply(
        `¡Hola! Soy ${agentName}, tu asistente personal.\n\n` +
        `Tu Telegram ID: <code>${userId}</code>\n\n` +
        `Para empezar a usar el bot, asegúrate de estar autorizado.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (text === "/help" || text?.startsWith("/help@")) {
      await ctx.reply(this.getHelpMessage(userId), { parse_mode: "HTML" });
      return;
    }

    if (text === "/stop" || text?.startsWith("/stop@")) {
      await ctx.reply("⏹ Detención actual cancelada.", { parse_mode: "HTML" });
      return;
    }

    if (text === "/new" || text?.startsWith("/new@")) {
      await ctx.reply("🔄 Sesión reiniciada.", { parse_mode: "HTML" });
      return;
    }

    // ── Extended commands ───────────────────────────────────────────────────

    if (text === "/status" || text?.startsWith("/status@")) {
      try {
        const provider = await getCodeConfig("active_provider");
        const mode = await getCodeConfig("active_mode");
        const activeTask = await latestTask(["running", "planning"]);
        const tokens = await tokenTotal24h();
        const cost = (tokens / 1_000_000 * 3).toFixed(4);

        await ctx.reply(
          `🐝 <b>Estado de hivecode</b>\n\n` +
          `Provider: <code>${provider ?? "N/A"}</code>\n` +
          `Modo: <code>${mode ?? "auto"}</code>\n` +
          `Costo hoy: <b>~$${cost}</b>\n` +
          (activeTask ? `\n✅ Tarea activa:\n<code>${activeTask.description?.slice(0, 60)}</code>` : "\n💤 Sin tarea activa"),
          { parse_mode: "HTML" }
        );
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text === "/tareas" || text?.startsWith("/tareas@")) {
      try {
        const tasks = await recentTasks(5);
        if (tasks.length === 0) {
          await ctx.reply("📋 Sin tareas registradas.");
          return;
        }
        const lines = tasks.map(t =>
          `${t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : "🔄"} ` +
          `<code>${t.id.slice(0, 8)}</code> — ${t.description?.slice(0, 50)}`
        );
        await ctx.reply(`📋 <b>Últimas tareas:</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text === "/narrativo" || text?.startsWith("/narrativo@")) {
      try {
        const entries = await recentNarrative(5);
        if (entries.length === 0) {
          await ctx.reply("📖 Sin entradas en el narrativo.");
          return;
        }
        const lines = entries.map(e =>
          `<b>[${e.coordinator}/${e.phase}]</b>\n${e.entry?.slice(0, 120)}…`
        );
        await ctx.reply(`📖 <b>Narrativo reciente:</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text?.startsWith("/buscar ") || text?.startsWith("/buscar@")) {
      const query = text.replace(/^\/buscar(@\S+)?\s*/, "").trim();
      if (!query) { await ctx.reply("Uso: /buscar <términos>"); return; }
      try {
        const rows = await recentNarrative(3, query);
        if (rows.length === 0) {
          await ctx.reply(`🔍 Sin resultados para: <i>${query}</i>`, { parse_mode: "HTML" });
          return;
        }
        const lines = rows.map(r => `<b>[${r.coordinator}]</b> ${r.entry?.slice(0, 100)}…`);
        await ctx.reply(`🔍 <b>Resultados:</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text === "/costo" || text?.startsWith("/costo@")) {
      try {
        const total = await tokenTotal24h();
        const usd = (total / 1_000_000 * 3).toFixed(4);
        await ctx.reply(
          `💰 <b>Costo (últimas 24h)</b>\n\nTokens: <code>${total.toLocaleString()}</code>\nUSD: <b>~$${usd}</b>`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text === "/modo" || text?.startsWith("/modo@")) {
      try {
        const current = await getCodeConfig("active_mode") ?? "auto";
        await ctx.reply(
          `🎛 <b>Modo actual:</b> <code>${current}</code>\n\nCambia con los botones:`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: current === "plan" ? "✅ plan" : "plan", callback_data: "mode:plan" },
                { text: current === "approval" ? "✅ approval" : "approval", callback_data: "mode:approval" },
                { text: current === "auto" ? "✅ auto" : "auto", callback_data: "mode:auto" },
              ]],
            },
          }
        );
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text === "/pausa" || text?.startsWith("/pausa@")) {
      try {
        const task = await latestTask(["running"]);
        if (!task) { await ctx.reply("💤 Sin tarea activa para pausar."); return; }
        await updateTaskStatus(task.id, "paused");
        await ctx.reply(`⏸ Tarea <code>${task.id.slice(0, 8)}</code> pausada.`, { parse_mode: "HTML" });
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text === "/reanudar" || text?.startsWith("/reanudar@")) {
      try {
        const task = await latestTask(["paused"]);
        if (!task) { await ctx.reply("💤 Sin tarea pausada para reanudar."); return; }
        await updateTaskStatus(task.id, "running");
        await ctx.reply(`▶️ Tarea <code>${task.id.slice(0, 8)}</code> reanudada.`, { parse_mode: "HTML" });
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text === "/cancelar" || text?.startsWith("/cancelar@")) {
      try {
        const task = await latestTask(["running", "planning"]);
        if (!task) { await ctx.reply("💤 Sin tarea activa para cancelar."); return; }
        await ctx.reply(
          `⚠️ ¿Cancelar tarea <code>${task.id.slice(0, 8)}</code>?\n<i>${task.description?.slice(0, 60)}</i>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "❌ Sí, cancelar", callback_data: `cancel_task:${task.id}` },
                { text: "⬅️ No", callback_data: "cancel_abort" },
              ]],
            },
          }
        );
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (text === "/doctor" || text?.startsWith("/doctor@")) {
      try {
        const providers = (await (await col<ProviderDoc>("providers")).scan()).map((entry) => entry.doc).slice(0, 3);
        const activeTasks = (await recentTasks(100)).filter((task) => task.status === "running").length;
        const lines = [
          `🩺 <b>Doctor hivecode</b>\n`,
          `HiveDB: ✅ conectada`,
          `Providers: ${providers.length > 0 ? providers.map(p => `${p.name} (${p.active ? "active" : "inactive"})`).join(", ") : "ninguno configurado"}`,
          `Tareas activas: ${activeTasks}`,
        ];
        await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      } catch (e) {
        await ctx.reply(`❌ Error: ${(e as Error).message}`);
      }
      return;
    }

    if (!isGroup && !this.isUserAllowed(chatId)) {
      this.log.debug(`Message from unauthorized user: ${chatId}`);
      const rejectMsg = this.config.dmPolicy === "allowlist"
        ? `⛔ No estás autorizado.\n\n` +
        `Tu Telegram ID: <code>${userId}</code>\n\n` +
        `Para autorizarte:\n` +
        `1. Ejecuta en el servidor: <code>hive config edit</code>\n` +
        `2. Añade bajo channels.telegram.accounts.default.allowFrom:\n` +
        `<pre>  - "tg:${userId}"</pre>\n` +
        `3. Ejecuta: <code>hive reload</code>`
        : `⛔ No estás autorizado para usar este bot.\n\n` +
        `Tu Telegram ID: <code>${userId}</code>`;
      await ctx.reply(rejectMsg, { parse_mode: "HTML" });
      return;
    }

    if (isGroup && !(this.config.groups ?? false)) {
      return;
    }

    // Track chat for proactive notifications (first authorized chat wins)
    if (!this.notifyChatId) {
      this.notifyChatId = message.chat.id;
    }

  let content = text;
  let contentType = "text";
  let image: IncomingMessage["image"];
  let document_: IncomingMessage["document"];

  if (message.photo && !text) {
    const caption = message.caption ?? "";
    contentType = "photo";
    try {
      const photos = message.photo;
      const largest = photos[photos.length - 1];
      if (largest && this.bot) {
        const file = await this.bot.api.getFile(largest.file_id);
        if (file.file_path) {
          image = {
            url: `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`,
            mimeType: "image/jpeg",
            caption: caption || undefined,
          };
        }
      }
    } catch (err) {
      this.log.warn(`Failed to download photo: ${(err as Error).message}`);
    }
    content = caption || "";
  }

    if (message.voice) {
      const voice = message.voice;
      const fileId = voice.file_id;

      let audioBuffer: Buffer | undefined;
      let audioUrl: string | undefined;

      try {
        const file = await this.bot!.api.getFile(fileId);
        const filePath = file.file_path;
        if (filePath) {
          audioUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${filePath}`;
        }
      } catch (error) {
        this.log.error(`Failed to get voice file: ${(error as Error).message}`);
      }

      const msgSessionId = this.formatSessionId(peerId, kind);

      const incomingMessage: IncomingMessage = {
        sessionId: msgSessionId,
        channel: "telegram",
        accountId: this.accountId,
        peerId,
        peerKind: kind,
        content: "",
        audio: audioBuffer ? { buffer: audioBuffer } : audioUrl ? { url: audioUrl, mimeType: "audio/ogg" } : undefined,
        metadata: {
          telegram: {
            chatId: message.chat.id,
            userId: message.from?.id,
            username: message.from?.username,
            messageId,
            chatType: message.chat.type,
            contentType: "voice",
          },
        },
        replyToId: message.reply_to_message
          ? `tg:${message.reply_to_message.message_id}`
          : undefined,
      };

      await this.handleMessage(incomingMessage);
      return;
    }

    if (message.sticker) {
      return;
    }

  if (message.document && !text) {
    const docName = (message.document as any).file_name ?? "documento";
    const caption = message.caption ?? "";
    contentType = "document";
    try {
      if (this.bot) {
        const file = await this.bot.api.getFile(message.document.file_id);
        if (file.file_path) {
          document_ = {
            url: `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`,
            mimeType: message.document.mime_type || "application/octet-stream",
            fileName: docName,
          };
        }
      }
    } catch (err) {
      this.log.warn(`Failed to download document: ${(err as Error).message}`);
    }
    content = caption || "";
  }

    const sessionId = this.formatSessionId(peerId, kind);
    this.chatIdCache.set(sessionId, message.chat.id);
    this.messageIdCache.set(sessionId, messageId);

  const incomingMessage: IncomingMessage = {
  sessionId,
  channel: "telegram",
  accountId: this.accountId,
  peerId,
  peerKind: kind,
  content: content ?? "",
  image,
  document: document_,
  metadata: {
        telegram: {
          chatId: message.chat.id,
          userId: message.from?.id,
          username: message.from?.username,
          messageId,
          chatType: message.chat.type,
          contentType,
        },
      },
      replyToId: message.reply_to_message
        ? `tg:${message.reply_to_message.message_id}`
        : undefined,
    };

    await this.handleMessage(incomingMessage);
  }

  private getHelpMessage(_userId: string): string {
    return `📚 <b>Comandos de hivecode:</b>

<b>Estado</b>
<code>/status</code>     — Estado del sistema (provider, modo, costo)
<code>/tareas</code>     — Últimas 5 tareas
<code>/narrativo</code>  — Últimas 5 entradas del narrativo
<code>/buscar &lt;q&gt;</code> — Buscar en el narrativo
<code>/costo</code>      — Costo acumulado del día
<code>/doctor</code>     — Diagnóstico del sistema

<b>Control</b>
<code>/modo</code>       — Ver y cambiar modo (plan/approval/auto)
<code>/pausa</code>      — Pausar tarea activa
<code>/reanudar</code>   — Reanudar tarea pausada
<code>/cancelar</code>   — Cancelar tarea activa

<b>Sistema</b>
<code>/myid</code>       — Tu Telegram ID
<code>/start</code>      — Iniciar conversación
<code>/help</code>       — Esta ayuda
<code>/stop</code>       — Detener bot
<code>/new</code>        — Reiniciar sesión

💡 <i>Envía texto libre para lanzar una tarea nueva.</i>`;
  }

  /** Proactively send a text notification to the last authorized chat */
  async sendNotification(text: string): Promise<void> {
    if (!this.bot || !this.notifyChatId) return;
    try {
      const html = this.markdownToHTML(text);
      await this.bot.api.sendMessage(this.notifyChatId, html, { parse_mode: "HTML" });
    } catch (e) {
      this.log.warn(`sendNotification failed: ${(e as Error).message}`);
    }
  }

  /** Send approval request for a completed phase and wait for user response (30 min timeout) */
  async sendApprovalRequest(opts: {
    taskId: string;
    phaseId: string;
    phase: string;
    summary: string;
  }): Promise<"approve" | "skip" | "timeout"> {
    if (!this.bot || !this.notifyChatId) return "approve"; // no bot → auto-approve
    const key = `${opts.taskId}:${opts.phaseId}`;

    try {
      await this.bot.api.sendMessage(
        this.notifyChatId,
        `📋 <b>Fase completada: ${opts.phase}</b>\n\n${opts.summary.slice(0, 600)}`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Aprobar", callback_data: `approve_phase:${opts.taskId}:${opts.phaseId}` },
              { text: "⏭ Saltar", callback_data: `skip_phase:${opts.taskId}:${opts.phaseId}` },
            ], [
              { text: "❌ Cancelar tarea", callback_data: `cancel_task:${opts.taskId}` },
            ]],
          },
        }
      );
    } catch (e) {
      this.log.warn(`sendApprovalRequest failed: ${(e as Error).message}`);
      return "approve";
    }

    return new Promise<"approve" | "skip" | "timeout">((resolve) => {
      this.approvalResolvers.set(key, resolve as any);
      const timeout = setTimeout(() => {
        this.approvalResolvers.delete(key);
        this.approvalTimeouts.delete(key);
        resolve("timeout");
      }, 30 * 60 * 1000);
      this.approvalTimeouts.set(key, timeout);
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.running = false;
      this.log.info("Telegram bot stopped");
      await setChannelStatus(this.accountId, "disconnected");
    }
  }

  private getChatIdFromSession(sessionId: string): number {
    const cached = this.chatIdCache.get(sessionId);
    if (cached) return cached;

    // Group format: "chatId:userId" (e.g. "-1001234567890:123456789")
    // The chat ID is the first segment before the colon.
    const colonIdx = sessionId.indexOf(":");
    if (colonIdx > 0) {
      const parsed = Number(sessionId.slice(0, colonIdx));
      if (!isNaN(parsed) && parsed !== 0) return parsed;
    }

    // Direct format: sessionId is the raw chatId (e.g. stored in user_identities)
    const direct = Number(sessionId);
    if (!isNaN(direct) && direct !== 0) return direct;

    return 0;
  }

  private getMessageIdFromSession(sessionId: string): number | undefined {
    return this.messageIdCache.get(sessionId);
  }

  async startTyping(sessionId: string): Promise<void> {
    if (!this.bot) return;

    const chatId = this.getChatIdFromSession(sessionId);
    if (isNaN(chatId)) return;

    await this.bot.api.sendChatAction(chatId, "typing");

    const interval = setInterval(async () => {
      try {
        await this.bot!.api.sendChatAction(chatId, "typing");
      } catch {
        this.stopTyping(sessionId);
      }
    }, 4000);

    this.typingIntervals.set(sessionId, interval);
  }

  async stopTyping(sessionId: string): Promise<void> {
    const interval = this.typingIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(sessionId);
    }
  }

  async send(sessionId: string, message: OutboundMessage): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started");
    }

    await this.stopTyping(sessionId);

    const chatId = this.getChatIdFromSession(sessionId);

    if (isNaN(chatId)) {
      throw new Error(`Invalid chat ID from session: ${sessionId}`);
    }

    const content = message.content ?? "";

    if (!content || content.trim().length === 0) {
      this.log.warn(`Empty response from agent, skipping send`, { sessionId, chatId });
      return;
    }

    const replyToId = this.getMessageIdFromSession(sessionId);
    const maxLength = 4096;

    try {
      if (content.length <= maxLength) {
        await this.sendWithRetry(chatId, content, replyToId);
      } else {
        const chunks = this.chunkMessage(content, maxLength);
        for (let i = 0; i < chunks.length; i++) {
          await this.sendWithRetry(chatId, chunks[i]!, i === 0 ? replyToId : undefined);
          if (i < chunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof GrammyError) {
        this.log.error(`Telegram API error: ${error.description}`);

        if (error.error_code === 403) {
          this.log.warn(`Bot was blocked by user: ${chatId}`);
          return;
        }
      } else if (error instanceof Error) {
        this.log.error(`Telegram send error: ${error.message}`);
      } else {
        this.log.error(`Telegram send error: ${String(error)}`);
      }
      throw error;
    }
  }

  async sendAudio(sessionId: string, audio: Buffer, mimeType: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not started");
    }

    const chatId = this.getChatIdFromSession(sessionId);

    if (isNaN(chatId)) {
      throw new Error(`Invalid chat ID from session: ${sessionId}`);
    }

    // Retry logic for sendVoice with exponential backoff
    const maxRetries = 2;
    const backoffMs = [3000, 6000];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Use explicit timeout for sendVoice (30 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const inputFile = new InputFile(audio, "voice.ogg");

        // Use type assertion to bypass grammY type limitations - signal is supported at runtime
        // via the underlying fetch API but not exposed in grammy's type definitions
        await this.bot!.api.sendVoice(chatId, inputFile, {
          signal: controller.signal,
        } as any);

        this.log.info(`✅ Voice sent to ${chatId}`);
        return;
      } catch (error: unknown) {
        const err = error as Error & { error_code?: number };

        // Don't retry on client errors (4xx)
        if (err.error_code === 400) {
          this.log.error(`Bad Request: ${err.message}`);
          throw error;
        }

        if (attempt < maxRetries - 1) {
          this.log.warn(`sendVoice attempt ${attempt + 1} failed, retrying in ${backoffMs[attempt]}ms: ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]));
        } else {
          this.log.error(`Telegram sendVoice failed after ${maxRetries} attempts: ${err.message}`);
          throw error;
        }
      } finally {
        // Always clear the timeout to prevent resource leaks
        clearTimeout(timeoutId);
      }
    }
  }

  private async sendWithRetry(
    chatId: number,
    text: string,
    replyToId?: number
  ): Promise<void> {
    const maxRetries = 3;
    const backoffMs = [1000, 2000, 4000];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const html = this.markdownToHTML(text);
        const options: any = { parse_mode: "HTML" };
        if (replyToId) {
          options.reply_parameters = { message_id: replyToId };
        }
        await this.bot!.api.sendMessage(chatId, html, options);
        return;
      } catch (error: unknown) {
        const err = error as Error & { error_code?: number; parameters?: { retry_after?: number } };

        if (err.error_code === 400 && err.message.includes("can't parse entities")) {
          this.log.warn(`Markdown parsing failed, falling back to plain text for chatId: ${chatId}`);
          await this.bot!.api.sendMessage(chatId, text, {
            reply_parameters: replyToId ? { message_id: replyToId } : undefined
          });
          return;
        }

        if (err.error_code === 400) {
          this.log.error(`Bad Request: ${err.message}`);
          throw error;
        }

        if (err.error_code === 429) {
          const retryAfter = err.parameters?.retry_after ?? 1;
          this.log.warn(`Rate limited, waiting ${retryAfter}s`);
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          continue;
        }

        if (attempt < maxRetries - 1) {
          this.log.warn(`Send failed, retrying in ${backoffMs[attempt]}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
        } else {
          throw error;
        }
      }
    }
  }

  private chunkMessage(content: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitPoint = remaining.lastIndexOf("\n\n", maxLength);
      if (splitPoint === -1 || splitPoint < maxLength * 0.5) {
        splitPoint = remaining.lastIndexOf("\n", maxLength);
      }
      if (splitPoint === -1 || splitPoint < maxLength * 0.5) {
        splitPoint = remaining.lastIndexOf(" ", maxLength);
      }
      if (splitPoint === -1 || splitPoint < maxLength * 0.5) {
        splitPoint = maxLength;
      }

      chunks.push(remaining.slice(0, splitPoint));
      remaining = remaining.slice(splitPoint).trim();
    }

    return chunks;
  }

  private markdownToHTML(text: string): string {
    // ── Step 1: extract code blocks before any escaping ────────────────────
    // Prevents code content from being HTML-escaped or markdown-converted.
    const codeBlocks: string[] = [];
    const inlineCodes: string[] = [];

    let out = text
      // Fenced code blocks (``` ... ```) — strip optional language hint
      .replace(/```(?:[^\n]*)\n?([\s\S]*?)```/g, (_m, code: string) => {
        const idx = codeBlocks.push(code.trim()) - 1;
        return `\x00BLOCK${idx}\x00`;
      })
      // Inline code (`...`)
      .replace(/`([^`\n]+)`/g, (_m, code: string) => {
        const idx = inlineCodes.push(code) - 1;
        return `\x00INLINE${idx}\x00`;
      });

    // ── Step 2: escape HTML entities in the remaining text ─────────────────
    out = out
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // ── Step 3: block-level conversions ────────────────────────────────────
    // Headers: ### h3, ## h2, # h1 → <b>text</b>
    out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

    // Horizontal rules → blank line
    out = out.replace(/^---+$/gm, "");

    // ── Step 4: inline conversions ─────────────────────────────────────────
    // Bold **text** or __text__
    out = out.replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>");
    out = out.replace(/__(.+?)__/gs, "<b>$1</b>");

    // Italic *text* (single star, not double) — avoid greedy cross-line
    out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "<i>$1</i>");

    // Italic _text_ — only match when surrounded by non-word chars (avoids snake_case)
    out = out.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/gs, "<i>$1</i>");

    // Strikethrough ~~text~~
    out = out.replace(/~~(.+?)~~/gs, "<s>$1</s>");

    // ── Step 5: restore code placeholders (now safely escaped) ─────────────
    // Restore inline code
    out = out.replace(/\x00INLINE(\d+)\x00/g, (_m, i) => {
      const code = inlineCodes[Number(i)] ?? "";
      return `<code>${code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`;
    });

    // Restore block code
    out = out.replace(/\x00BLOCK(\d+)\x00/g, (_m, i) => {
      const code = codeBlocks[Number(i)] ?? "";
      return `<pre><code>${code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`;
    });

    return out;
  }
}

export function createTelegramChannel(accountId: string, config: TelegramConfig): TelegramChannel {
  return new TelegramChannel(accountId, config);
}
