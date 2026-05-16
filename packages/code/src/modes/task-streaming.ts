/**
 * Task WebSocket Streaming
 *
 * Re-exported from @johpaz/hivecode-core/gateway/task-streaming.
 * The canonical implementation lives in packages/core to avoid circular
 * dependencies (gateway in core needs to manage WebSocket subscriptions).
 */

export {
  subscribeTask,
  unsubscribeTask,
  subscribeSession,
  unsubscribeSession,
  unsubscribeAll,
  broadcastNarrative,
  broadcastPhase,
  broadcastMode,
  taskEventStream,
} from "@johpaz/hivecode-core/gateway/task-streaming";
