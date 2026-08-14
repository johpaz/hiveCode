/**
 * Chat API - Endpoint para enviar mensajes al coordinador
 * 
 * POST /api/chat
 * {
 *   "message": "Mensaje para el coordinador",
 *   "thread_id": "ID de sesión (opcional, se genera si no existe)",
 *   "channel": "canal (opcional, default: webchat)"
 * }
 */

import { resolveUserId, resolveAgentId } from "../../storage/onboarding";
import { laneQueue } from "../lane-queue";
import { getRecentMessages, listAllScratchpadNotes, saveScratchpadNote } from "../../agent/conversation-store";
import { AgentRunner, DEFAULT_INTERACTIVE_MAX_STEPS } from "../../agent/providers";
import { logger } from "../../utils/logger";
import { col, fromIndexable } from "../../storage/hive";
import type { AgentDoc, UserDoc } from "../../storage/collections";

const log = logger.child("api:chat");

export interface ChatRequest {
  message: string;
  thread_id?: string;
  channel?: string;
  userId?: string;
  agentId?: string;
}

export interface ChatResponse {
  success: boolean;
  thread_id: string;
  content?: string;
  error?: string;
}

export async function handleChat(
  req: Request,
  addCorsHeaders: (res: Response, req: Request) => Response
): Promise<Response> {
  try {
    const body = await req.json();
    const { message, thread_id, channel = "webchat", userId, agentId }: ChatRequest = body;

    if (!message) {
      return addCorsHeaders(
        Response.json({ 
          success: false, 
          error: "Message is required" 
        }, { status: 400 }),
        req
      );
    }

    // Resolve user ID
  const finalUserId = userId || await resolveUserId() || "default";

  // Resolve agent ID (coordinator by default)
  const finalAgentId = agentId || await resolveAgentId() || "main";

    // Generate or use provided thread_id
    const threadId = thread_id || `${finalUserId}-${Date.now()}`;

    log.info(`[chat] Processing message from user=${finalUserId} agent=${finalAgentId} thread=${threadId}`);

    // Get user timezone for timestamp
    const userRow = (await (await col<UserDoc>("users")).get(finalUserId))?.doc;
    const userTimezone = userRow?.timezone || "UTC";
    const now = new Date();
    
    let exactTime: string;
    try {
      exactTime = now.toLocaleString("en-US", {
        timeZone: userTimezone,
        dateStyle: "full",
        timeStyle: "long",
      });
    } catch (e) {
      exactTime = now.toISOString();
    }

    // Format message with timestamp
    const messageContent = `[Timestamp: ${exactTime} (${userTimezone})]\n${message}`;

    // Get recent conversation history
    const history = await getRecentMessages(threadId, 15);
    const messages = [
      ...history.map((row) => ({
        role: row.role as "user" | "assistant" | "system",
        content: row.content,
      })),
      { role: "user" as const, content: messageContent }
    ];

    // Get provider config from DB
    const agent = (await (await col<AgentDoc>("agents")).get(finalAgentId))?.doc;

    const provider = fromIndexable(agent?.provider_id) || "gemini";

    // Create runner
    const runner = new AgentRunner({} as any);

    let responseContent = "";
    let responseError: string | null = null;

    // Enqueue in lane queue for processing
    laneQueue.enqueue(threadId, async (_task, signal) => {
      if (signal.aborted) return;

      try {
        log.info(`[chat] Generating response for thread ${threadId}...`);

        const response = await runner.generate({
          provider: provider as any,
          messages,
          rawUserMessage: message,
          maxTokens: 4096,
          maxSteps: DEFAULT_INTERACTIVE_MAX_STEPS,
          threadId,
          userId: finalUserId,
          channel,
          onStep: async (step) => {
            if (step.type === "text" && step.message) {
              log.debug(`[chat] Step: ${step.message.substring(0, 100)}`);
            }
            if (step.type === "tool_result" && step.message) {
              log.debug(`[chat] Tool result: ${step.message.substring(0, 100)}`);
            }
          },
        });

        responseContent = response.content?.trim() || "Task completed.";
        log.info(`[chat] Response generated: ${responseContent.substring(0, 100)}...`);

      } catch (error) {
        log.error(`[chat] Error for thread ${threadId}: ${(error as Error).message}`);
        responseError = (error as Error).message;
      }
    });

    // Wait for processing to complete (with timeout)
    const startTime = Date.now();
    const timeout = 120000; // 2 minutes timeout

    while (!responseContent && !responseError) {
      if (Date.now() - startTime > timeout) {
        return addCorsHeaders(
          Response.json({
            success: false,
            error: "Request timeout",
            thread_id: threadId,
          }, { status: 504 }),
          req
        );
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (responseError) {
      return addCorsHeaders(
        Response.json({
          success: false,
          error: responseError,
          thread_id: threadId,
        }, { status: 500 }),
        req
      );
    }

    return addCorsHeaders(
      Response.json({
        success: true,
        thread_id: threadId,
        content: responseContent,
      }),
      req
    );

  } catch (error) {
    log.error(`[chat] Handler error: ${(error as Error).message}`);
    return addCorsHeaders(
      Response.json({
        success: false,
        error: (error as Error).message,
        message: "Internal server error",
      }, { status: 500 }),
      req
    );
  }
}

// ── Original Chat API Functions ─────────────────────────────────────────────

export async function handleGetChatHistory(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const url = new URL(req.url)
  const threadId = url.searchParams.get("sessionId") || url.searchParams.get("threadId") || "default"
  const limit = parseInt(url.searchParams.get("limit") || "15")

  const messages = (await getRecentMessages(threadId, limit))
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ ...message }))

  return addCorsHeaders(Response.json({ messages }), req)
}

export async function handleGetCanvas(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  return addCorsHeaders(Response.json({ nodes: [], edges: [] }), req)
}

export async function handleGetNotes(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const notes = await listAllScratchpadNotes(50)
  
  return addCorsHeaders(Response.json({ notes }), req)
}

export async function handleUpdateNote(req: Request, addCorsHeaders: (r: Response, req: Request) => Response): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const { threadId, content } = body
  
  if (!threadId || !content) {
    return addCorsHeaders(Response.json({ success: false, error: "threadId and content required" }), req)
  }
  
  await saveScratchpadNote(threadId, "note", content, "api")
  
  return addCorsHeaders(Response.json({ success: true }), req)
}
