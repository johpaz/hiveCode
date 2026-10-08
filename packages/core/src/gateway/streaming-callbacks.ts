import type { OutboundMessage } from "./slash-commands";

interface Options { send: (message: string) => unknown; signal: AbortSignal; sessionId: string; messageId: string; appendToken: (token: string) => void; narration: (tool: string) => string }
export function createStreamingCallbacks(options: Options) {
 const {send, signal, sessionId: unifiedSessionId, messageId, appendToken, narration: getNarration}=options;
 return {
onToken: async (token: string) => {
                    if (signal.aborted) return;
                    appendToken(token);
                    // Send chunk to client
                    send(JSON.stringify({
                      type: "message",
                      id: messageId,
                      sessionId: unifiedSessionId,
                      content: token,
                      isChunk: true,
                      isStep: false,
                    } as OutboundMessage));
                  },
onStep: async (step: {type: string; message?: string; toolName?: string}) => {
                    if (signal.aborted) return;

                    // "text" = el agente narra lo que esta pensando/haciendo
                    if (step.type === "text" && step.message) {
                      const trimmedMessage = (typeof step.message === "string" ? step.message : "").trim();
                      if (trimmedMessage) {
                        send(JSON.stringify({
                          type: "progress",
                          sessionId: unifiedSessionId,
                          content: trimmedMessage,
                        } as OutboundMessage));
                      }
                      return;
                    }

                    // "tool_call" = el agente va a ejecutar una herramienta → narrar al usuario
                    if (step.type === "tool_call" && step.toolName) {
                      const narration = getNarration(step.toolName);
                      send(JSON.stringify({
                        type: "progress",
                        sessionId: unifiedSessionId,
                        content: narration,
                      } as OutboundMessage));
                      return;
                    }

                    // "tool_result" = resultado de herramienta → solo si pide enviarse al usuario
                    if (step.type === "tool_result" && step.message) {
                      try {
                        const result = JSON.parse(step.message);
                        if (result._sendToUser || result.status) {
                          const userMessage = result.message || result.status || "";
                          if (userMessage) {
                            send(JSON.stringify({
                              type: "progress",
                              sessionId: unifiedSessionId,
                              content: userMessage,
                            } as OutboundMessage));
                          }
                          return;
                        }
                      } catch { }
                    }
                  },
 };
}
