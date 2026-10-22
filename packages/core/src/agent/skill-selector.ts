/**
 * HiveDB-based Dynamic Skill Selector Module
 * 
 * Context Compiler Level 4 - Intelligent Skill Selection
 * 
 * This module uses HiveDB BM25 scoring to select the most relevant skills
 * based on the user message, similar to tool selection.
 * 
 * DESIGN DECISIONS:
 * 
 * 1. Reads from skills table in database (not hardcoded catalog)
 * 2. Maximum 5 skills per turn for balanced context injection
 * 3. Relevance threshold for conversational messages
 * 4. Uses skill descriptions for HiveDB BM25 matching
 * 5. Returns skill content for injection into system prompt
 */

import { col } from "../storage/hive"
import type { SkillDoc } from "../storage/collections"
import { logger } from "../utils/logger"
import {
    searchCapabilities,
    applyRelativeCutoff,
    replaceCapabilityDocs,
    type CapabilityDoc,
} from "./capability-search"
import { isMinimalSkill } from "./minimal-loadout"

const log = logger.child("skill-selector")

// ─── Minimal Skill Set ─────────────────────────────────────────────────────────

// No hay lista de skills minimaleas: se derivan de las tools del loadout
// (minimal-loadout.ts). Una skill es mínima cuando todas las tools que
// documenta ya están disponibles sin descubrimiento. Fijar los nombres a mano
// ya divergió una vez — la lista pineaba skills cuyas tools no estaban en el
// loadout, de modo que anunciaban capacidades que el modelo no tenía.

// ─── Types ───────────────────────────────────────────────────────────────────────

export interface SkillDescriptor {
    id: string
    name: string
    description: string
    category: string
    tools: string
    triggers: string
    preferred_agents: string
    body: string
    version: string
    version_num: number
    active: boolean
}

export function toSkillDescriptor(doc: SkillDoc): SkillDescriptor {
    return {
        id: doc.id,
        name: doc.name,
        description: doc.description ?? "",
        category: doc.category,
        tools: doc.tools,
        triggers: doc.triggers,
        preferred_agents: doc.preferred_agents,
        body: doc.body,
        version: doc.version,
        version_num: doc.version_num,
        active: doc.active,
    }
}

export interface SelectedSkill {
    id: string
    name: string
    score: number
    category: string
    description: string
    body: string
}

export interface SkillSelectorResult {
    skills: SkillDescriptor[]
    selected: SelectedSkill[]
    reasoning: string
    timingMs: number
}

// ─── Configuration ─────────────────────────────────────────────────────────

/** Maximum skills to return per message */
const MAX_SKILLS_PER_TURN = 4  // Increased from 2 to allow more skills

/**
 * Relative relevance cutoff: keep a hit only if it scores at least this
 * fraction of the top hit. HiveDB BM25 scores are positive (higher = better)
 * but corpus-dependent, so absolute thresholds do not transfer.
 */
const RELEVANCE_RATIO = 0.3

/** Stopwords used by conversational filtering before capability search */
const STOPWORDS = new Set([
    "que", "con", "para", "por", "una", "uno", "los", "las", "del",
    "como", "esta", "esto", "ese", "eso", "the", "and", "for",
    "with", "this", "that", "have", "will", "also", "de", "en",
    "el", "la", "se", "su", "sus", "al", "es", "son", "pero",
    "más", "mas", "ya", "yo", "tu", "te", "ti", "mi", "me",
    "hola", "hi", "hello", "hey", "gracias", "thank", "please",
    "ok", "okay", "yes", "si", "no", "bien", "good", "great",
    "puedes", "necesito", "quiero", "podés", "necesitás", "querés",
])

/** Conversational patterns that should return empty skill list */
const CONVERSATIONAL_PATTERNS = [
    /^(hola|hi|hello|hey|buenos? días?|buenas? noches?|qué tal|howdy)/i,
    /^(gracias|thank you|thanks|muchas gracias|muchas thanks)/i,
    /^(cómo estás?|how are you?|qué流水|you doing|qué cuentas)/i,
    /^(sí|yes|ok|okay|de acuerdo|perfecto|claro|por supuesto)/i,
    /^(adiós|bye|nos vemos|see you|later|chau)/i,
    /^(entiendo|understand|i see|ya veo|got it)/i,
    /^(bien|good|great|excelente|awesome|perfect)/i,
    /^(?:\?|¿)$/,  // Just a question mark
]

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Check if message is purely conversational (no skills needed)
 */
function isConversational(message: string): boolean {
    const trimmed = message.trim()

    // Empty or very short messages
    if (trimmed.length < 2) return true

    // Check conversational patterns
    for (const pattern of CONVERSATIONAL_PATTERNS) {
        if (pattern.test(trimmed)) {
            log.debug(`[skill-selector] Message matched conversational pattern: ${pattern}`)
            return true
        }
    }

    // Check if all words are stopwords (likely conversational)
    const words = trimmed.toLowerCase().split(/\s+/)
    const meaningfulWords = words.filter(w => w.length > 2 && !STOPWORDS.has(w))
    if (meaningfulWords.length === 0) {
        log.debug(`[skill-selector] All words are stopwords - conversational`)
        return true
    }

    return false
}

// ─── Main Selection Function ─────────────────────────────────────────────────

/** Tokens of a skill's body as it would sit in the system prompt (the harness's 3.5 chars per token). */
export const skillTokens = (skill: Pick<SkillDescriptor, "body">): number => Math.ceil((skill.body ?? "").length / 3.5)

/** Triggers of a skill that appear in the text, counted (not just "any"): three matches say more than one. */
function triggerHits(message: string, triggers: string | null): number {
    if (!triggers) return 0
    const lower = message.toLowerCase()
    return triggers.split(",").map(t => t.trim().toLowerCase()).filter(Boolean).filter(t => lower.includes(t)).length
}

/** Roles a skill was written for (`preferred_agents` is a JSON list or empty). */
function preferredRoles(skill: Pick<SkillDescriptor, "preferred_agents">): string[] {
    try {
        const value = JSON.parse(skill.preferred_agents || "[]")
        return Array.isArray(value) ? value.map(String) : []
    } catch { return [] }
}

export interface RankOptions {
    /** The agent profile asking (`scout`, `builder`…): skills written for other roles score lower, for this one higher. */
    role?: string
    limit?: number
    /** Most tokens of skill bodies to return; the best skill is always kept, even if it alone exceeds it. */
    tokenBudget?: number
}

/**
 * Skills that fit a text, best first. Three signals, all from the database:
 *  - triggers: each trigger found in the text counts (before, the first match returned ONE skill and stopped);
 *  - the capability index (BM25 over name, description and body), relative to the best hit;
 *  - the role: `preferred_agents` boosts a skill for its roles and mutes it for the others.
 * A skill needs a trigger or a relevant hit to be considered. The result respects a token budget, because a skill is
 * not free: its whole body rides in the prompt of every turn.
 */
export async function rankSkills(text: string, options: RankOptions = {}): Promise<SkillDescriptor[]> {
    const limit = options.limit ?? MAX_SKILLS_PER_TURN
    if (isConversational(text)) return []
    const skills = (await (await col<SkillDoc>("skills")).scan({})).filter(e => e.doc.active).map(e => toSkillDescriptor(e.doc))
    const byId = new Map(skills.map(skill => [skill.id, skill]))

    let relevance = new Map<string, number>()
    try {
        const hits = await searchCapabilities(text, { types: ["skill"], k: 20 })
        const top = hits.reduce((max, hit) => Math.max(max, hit.score), 0)
        if (top > 0) relevance = new Map(applyRelativeCutoff(hits, RELEVANCE_RATIO).map(hit => [hit.rawId, hit.score / top]))
    } catch (err) {
        log.error(`[skill-selector] Capability search failed:`, err)
    }

    const ranked = skills.flatMap(skill => {
        const triggers = Math.min(3, triggerHits(text, skill.triggers))
        const semantic = relevance.get(skill.id) ?? 0
        if (triggers === 0 && semantic === 0) return []
        const roles = preferredRoles(skill)
        const fit = options.role && roles.length ? (roles.includes(options.role) ? 1.25 : 0.5) : 1
        return [{ skill, score: (triggers + semantic) * fit }]
    }).sort((a, b) => b.score - a.score)

    const chosen: SkillDescriptor[] = []
    let spent = 0
    for (const { skill } of ranked) {
        if (chosen.length >= limit) break
        const cost = skillTokens(skill)
        if (chosen.length > 0 && options.tokenBudget !== undefined && spent + cost > options.tokenBudget) continue
        chosen.push(skill)
        spent += cost
    }
    log.debug(`[skill-selector] ${chosen.length} skills for "${text.slice(0, 60)}": ${chosen.map(s => s.name).join(", ")}`)
    return chosen
}

/** Skills for a user message (coordinator turns): the same ranking, no role and no token budget. */
export async function selectSkills(userMessage: string): Promise<SkillDescriptor[]> {
    return rankSkills(userMessage, { limit: MAX_SKILLS_PER_TURN })
}

// ─── Minimal Skills Loader ───────────────────────────────────────────────────

/**
 * Skills whose documented tools are all already in the loadout, so they are
 * always available without paying for discovery. Derived, not listed — see
 * minimal-loadout.ts.
 */
export async function getMinimalSkills(): Promise<SkillDescriptor[]> {
    try {
        const skillsCol = await col<SkillDoc>("skills")
        const skills = (await skillsCol.scan({}))
            .filter(e => e.doc.active && isMinimalSkill(e.doc.tools))
            .map(e => toSkillDescriptor(e.doc))

        log.info(`[skill-selector] Loaded ${skills.length} minimal skills: ${skills.map(s => s.name).join(", ")}`)
        return skills
    } catch (err) {
        log.error(`[skill-selector] Failed to load minimal skills:`, err)
        return []
    }
}

// ─── Sync Skills to HiveDB ──────────────────────────────────────────────────

/**
 * Sync all enabled skills from database to the HiveDB capability index.
 * Should be called on initialization from gateway/initializer.ts
 */
export async function syncSkillsToIndex(): Promise<void> {
    try {
        // Step 1: Get all enabled skills from HiveDB
        const skillsCol = await col<SkillDoc>("skills")
        const dbSkills = (await skillsCol.scan({})).map(e => e.doc).filter(s => s.active)

        if (dbSkills.length === 0) {
            log.debug(`[skill-selector] No skills found in DB to sync`)
        }

        // Step 2: Replace all skill documents in the HiveDB capability index
        const docs: CapabilityDoc[] = dbSkills.map(skill => ({
            type: "skill" as const,
            rawId: skill.id,
            name: skill.name,
            tags: [skill.triggers, skill.category, skill.tools].filter(Boolean).join(" "),
            body: [skill.description, skill.body].filter(Boolean).join("\n"),
        }))

        await replaceCapabilityDocs("skill", docs)

        log.info(`[skill-selector] Sync complete: ${dbSkills.length} skills indexed in HiveDB`)

    } catch (err) {
        log.error(`[skill-selector] Skill index sync failed:`, err)
        throw err // Re-throw to inform initializer
    }
}
// ─── Initialization ───────────────────────────────────────────────────────

/**
 * Initialize the skill selector
 * DEPRECATED: syncSkillsToIndex() is now called from gateway/initializer.ts
 * This function is kept for backward compatibility but is no longer needed
 */
export function initializeSkillSelector(): void {
    log.info(`[skill-selector] Initializing skill selector (deprecated - sync is done in gateway/initializer.ts)`)
    // syncSkillsToIndex() - No longer needed here, done in gateway/initializer.ts
}

// ─── Debug/Test Helpers ─────────────────────────────────────────────────────

/**
 * Get all enabled skills from database (for debugging/testing)
 */
export async function getAllSkillsFromDB(): Promise<SkillDescriptor[]> {
    try {
        const skillsCol = await col<SkillDoc>("skills")
        return (await skillsCol.scan({})).filter(e => e.doc.active).map(e => toSkillDescriptor(e.doc))
    } catch (err) {
        log.error(`[skill-selector] Failed to fetch skills:`, err)
        return []
    }
}

/**
 * Get skill by name
 */
export async function getSkillByName(name: string): Promise<SkillDescriptor | undefined> {
    try {
        const skillsCol = await col<SkillDoc>("skills")
        const match = (await skillsCol.scan({})).find(e => e.doc.name === name && e.doc.active)
        return match ? toSkillDescriptor(match.doc) : undefined
    } catch (err) {
        log.error(`[skill-selector] Failed to fetch skill by name:`, err)
        return undefined
    }
}

/**
 * Get skills by category
 */
export async function getSkillsByCategory(category: string): Promise<SkillDescriptor[]> {
    try {
        const skillsCol = await col<SkillDoc>("skills")
        const entries = await skillsCol.findBy("category", category)
        return entries.filter(e => e.doc.active).map(e => toSkillDescriptor(e.doc))
    } catch (err) {
        log.error(`[skill-selector] Failed to fetch skills by category:`, err)
        return []
    }
}
