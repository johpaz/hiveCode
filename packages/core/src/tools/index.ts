/**
 * Tools Registry - Exports all 94 tools
 * 
 * Import this to get all tools:
 * import { createAllTools } from "./tools";
 */

import type { Tool } from "./types.ts";
import type { Config } from "../config/loader.ts";

// Filesystem (7)
import * as filesystem from "./filesystem/index.ts";

// Web (9)
import * as web from "./web/index.ts";



// Cron (8)
import * as cron from "./cron/index.ts";

// CLI (1)
import * as cli from "./cli/index.ts";

// Agents (15)
import * as agents from "./agents/index.ts";

// Code tools (16) - git + code utilities
import * as code from "./code/index.ts";

// Core (4)
import * as core from "./core/index.ts";

// Narrative (6)
import * as narrative from "./narrative/index.ts";

// API (1) - HTTP client for REST APIs
import * as api from "./api/index.ts";

/**
 * Creates all tools with proper configuration
 */
export function createAllTools(config: Config): Tool[] {
  return [
    // FILESYSTEM (7)
    ...filesystem.createTools(),

    // WEB (9)
    ...web.createTools(),

    // CRON (7)
    ...cron.createTools(),

    // CLI (1)
    ...cli.createTools(),

    // AGENTS (14)
    ...agents.createTools(),

    // CODE TOOLS (16) - git + code utilities + analysis
    ...code.createTools(),

    // CORE (4)
    ...core.createTools(),

    // NARRATIVE (6)
    ...narrative.createTools(),

    // API (1) - HTTP client for REST APIs
    ...api.createTools(),
  ];
}

/**
 * Creates tools by category (for selective loading)
 */
export function createToolsByCategory(category: string, config: Config): Tool[] {
  switch (category) {
    case "filesystem":
      return filesystem.createTools();
    case "web":
      return web.createTools();
    case "cron":
      return cron.createTools();
    case "cli":
      return cli.createTools();
    case "agents":
      return agents.createTools();
    case "code":
      return code.createTools();
    case "core":
      return core.createTools();
    case "narrative":
      return narrative.createTools();
    case "api":
      return api.createTools();
    default:
      return [];
  }
}

// Export types
export * from "./types.ts";

// Export tools by category (avoiding createTools name collisions)
// Use category-specific imports or createAllTools/createToolsByCategory
export {
  fsEditTool,
  fsReadTool,
  fsWriteTool,
  fsDeleteTool,
  fsListTool,
  fsGlobTool,
  fsExistsTool,
} from "./filesystem/index.ts";

export {
  webSearchTool,
  webFetchTool,
  browserScreenshotTool,
  browserCaptureClipboardTool,
  browserPreviewHtmlTool,
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserExtractTool,
  browserScriptTool,
  browserWaitTool,
} from "./web/index.ts";

export {
  cronCreateTool,
  cronListTool,
  cronUpdateTool,
  cronPauseTool,
  cronResumeTool,
  cronDeleteTool,
  cronTriggerTool,
  cronHistoryTool,
  setSchedulerInstance,
  resolveBestChannel,
} from "./cron/index.ts";

export { cliExecTool } from "./cli/index.ts";

export {
  memoryWriteTool,
  memoryReadTool,
  memoryListTool,
  memorySearchTool,
  memoryDeleteTool,
  agentCreateTool,
  agentFindTool,
  agentArchiveTool,
  taskDelegateTool,
  taskDelegateCodeTool,
  taskStatusTool,
  busPublishTool,
  busReadTool,
  projectUpdatesTool,
  spawnAgentTool,
} from "./agents/index.ts";




export {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitBranchTool,
  gitCommitTool,
  codeSearchTool,
  codeBuildTool,
  codeTestTool,
  codeTestParallelTool,
  codeLintTool,
  codeDiffCreateTool,
  parseAstTool,
  findImportsTool,
  checkTypesTool,
  runScriptTool,
  gitBlameTool,
  gitCreatePrTool,
  gitRollbackTool,
} from "./code/index.ts";

export {
  searchKnowledgeTool,
  notifyTool,
  saveNoteTool,
  reportProgressTool,
} from "./core/index.ts";

export { apiRequestTool } from "./api/index.ts";

export {
  readNarrativeTool,
  appendNarrativeTool,
  searchNarrativeTool,
  readDecisionsTool,
  writeDecisionTool,
  getTaskContextTool,
} from "./narrative/index.ts";
