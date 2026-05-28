export * from "./coordinator-manager"
export * from "./types"
export * from "./secrets"
export * from "./tool-bridge"
export * from "./plan-parser"
// subagent-registry re-exports from subagent-prompts, so only export from registry to avoid duplicates
export * from "./subagent-registry"
export { discoverDynamicSubAgents } from "./db-discovery"
