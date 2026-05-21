export * from "./workers/index"
export * from "./context/index"
export * from "./checkpoint/index"
export * from "./adr/index"
export * from "./narrative/index"
export * from "./modes/index"
export * from "./modes/task-streaming"
export * from "./modes/keyboard"
export * from "./modes/interruptions"
export { seedCodeData } from "./seed"

import type { BootstrapModule } from "@johpaz/hivecode-core"
import { initializeCodeDatabase, validateCodeSchema } from "./narrative/index"
import { seedCodeData } from "./seed"

export const HiveCodeModule: BootstrapModule = {
  name: "hive-code",
  initializeSchema: () => initializeCodeDatabase(),
  seedData: (_, force) => seedCodeData(force),
  validate: () => validateCodeSchema()
}
