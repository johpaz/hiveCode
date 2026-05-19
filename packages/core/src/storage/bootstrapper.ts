import { initializeDatabase, type Database } from "./sqlite";
import { logger } from "../utils/logger";
import { CoreModule } from "./core-module";

export interface BootstrapModule {
  name: string;
  initializeSchema?: (db: Database) => void;
  seedData?: (db: Database, force?: boolean) => void;
  validate?: (db: Database) => boolean;
  getTools?: () => any[];
}

const modules: BootstrapModule[] = [];

export function registerModule(module: BootstrapModule): void {
  modules.push(module);
}

export function getAllModuleTools(): any[] {
  const allTools: any[] = [];
  const allModules = [CoreModule, ...modules];
  for (const module of allModules) {
    if (module.getTools) {
      allTools.push(...module.getTools());
    }
  }
  return allTools;
}

export function bootstrap(options: { force?: boolean } = {}): void {
  logger.info("🚀 Iniciando Bootstrap del sistema...");

  // 1. Core DB Init
  const db = initializeDatabase();

  // 2. Register and Run Core Module first
  const allModules = [CoreModule, ...modules];

  // 3. Module Init & Seed
  for (const module of allModules) {
    try {
      if (module.initializeSchema) {
        module.initializeSchema(db);
        logger.info(`[bootstrap] Schema de '${module.name}' inicializado`);
      }
      if (module.seedData) {
        module.seedData(db, options.force);
        logger.info(`[bootstrap] Seed de '${module.name}' completado`);
      }
      if (module.validate) {
        if (module.validate(db)) {
          logger.info(`[bootstrap] '${module.name}' validado correctamente`);
        }
      }
    } catch (err) {
      logger.error(`[bootstrap] Error en módulo '${module.name}':`, (err as Error).message);
    }
  }

  logger.info("✅ Bootstrap completado con éxito");
}
