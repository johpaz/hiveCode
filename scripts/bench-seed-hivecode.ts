/**
 * A clean hivecode state for one benchmark run: a fresh database with only the provider and model set.
 * The other agents run without the user's customisation, so hivecode does too (no learned rules, no memory).
 *
 *   HIVE_HOME=<dir> HIVE_DB_PATH=<dir>/db bun scripts/bench-seed-hivecode.ts <provider> <model>
 */
import { bootstrap } from "../packages/core/src/storage/bootstrapper"
import { col } from "../packages/core/src/storage/hive"
import { closeHiveDb } from "../packages/core/src/storage/hivedb"

const [provider, model] = process.argv.slice(2)
if (!provider || !model) { console.error("uso: bench-seed-hivecode.ts <provider> <model>"); process.exit(2) }
await bootstrap({ force: true })
const config = await col<any>("codeConfig")
const now = Math.floor(Date.now() / 1000)
await config.put("default_provider", { key: "default_provider", value: provider, created_at: now, updated_at: now })
await config.put(`provider_model_${provider}`, { key: `provider_model_${provider}`, value: model, created_at: now, updated_at: now })
closeHiveDb()
process.exit(0)
