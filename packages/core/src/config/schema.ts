/**
 * Config schema — Zod validation for ~/.hivecode/config.json
 */

import { z } from "zod"

export const bindingMatchSchema = z.object({
  channel: z.string().optional(),
  accountId: z.string().optional(),
  peer: z.object({ id: z.string().optional(), kind: z.string().optional() }).optional(),
  guildId: z.string().optional(),
  roles: z.array(z.string()).optional(),
  teamId: z.string().optional(),
})

export const bindingSchema = z.object({
  agentId: z.string(),
  match: bindingMatchSchema,
})

export const configSchema = z.object({
  port: z.number().int().min(1).max(65535).default(16120),
  host: z.string().default("0.0.0.0"),
  database: z.object({ path: z.string().optional() }).optional(),
  security: z.object({
    warnOnInsecureConfig: z.boolean().default(true),
    authToken: z.string().optional(),
  }).optional(),
  providers: z.record(z.string(), z.any()).optional(),
  channels: z.record(z.string(), z.any()).optional(),
  skills: z.any().optional(),
  cron: z.any().optional(),
  tts: z.any().optional(),
  vision: z.any().optional(),
  mcp: z.object({ servers: z.record(z.string(), z.any()) }).optional(),
  gateway: z.object({
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().optional(),
    pidFile: z.string().optional(),
  }).optional(),
  logging: z.object({ level: z.string().default("info") }).optional(),
  models: z.object({
    defaultProvider: z.string().optional(),
    defaults: z.record(z.string(), z.string()).optional(),
    providers: z.record(z.string(), z.any()).optional(),
    llm: z.record(z.string(), z.any()).optional(),
    embeddings: z.record(z.string(), z.any()).optional(),
  }).optional(),
  hooks: z.object({ scripts: z.array(z.string()) }).optional(),
  bindings: z.array(bindingSchema).optional(),
  agent: z.object({
    defaultAgentId: z.string().optional(),
    baseDir: z.string().optional(),
  }).optional(),
  sandbox: z.object({
    enabled: z.boolean().default(false),
    mode: z.enum(['auto-allow', 'permissions']).default('permissions'),
    filesystem: z.object({
      allowWrite: z.array(z.string()).default([]),
      denyWrite: z.array(z.string()).default([]),
      denyRead: z.array(z.string()).default([]),
      allowRead: z.array(z.string()).default([]),
    }).default({
      allowWrite: [],
      denyWrite: [],
      denyRead: [],
      allowRead: [],
    }),
    network: z.object({
      enabled: z.boolean().default(true),
      allowedDomains: z.array(z.string()).default([]),
    }).default({
      enabled: true,
      allowedDomains: [],
    }),
    excludedCommands: z.array(z.string()).default([]),
    failIfUnavailable: z.boolean().default(false),
  }).optional(),
  workspace: z.object({
    path: z.string().optional(),
    activeProject: z.string().optional(),
  }).optional(),
})

export type ValidatedConfig = z.infer<typeof configSchema>