import { getDb } from "@johpaz/hivecode-core/storage/sqlite"
import { parseInternalCommand, getCtx } from "@johpaz/hivecode-code/coordinator/command-parser"

const db = getDb()
const ctx = getCtx(db)

async function main() {
  const r1 = await parseInternalCommand("/mode", db, ctx)
  console.log("/mode:", JSON.stringify(r1, null, 2))

  const r2 = await parseInternalCommand("/provider", db, ctx)
  console.log("/provider:", JSON.stringify(r2, null, 2))

  const r3 = await parseInternalCommand("/telegram", db, ctx)
  console.log("/telegram:", JSON.stringify(r3, null, 2))
}

main()
