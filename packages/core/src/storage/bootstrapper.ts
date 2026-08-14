import { logger } from "../utils/logger";
import { ensureHiveDb } from "./bootstrap";

export interface BootstrapModule {
  name: string;
  initializeSchema?: () => void | Promise<void>;
  seedData?: (force?: boolean) => void | Promise<void>;
  validate?: () => boolean | Promise<boolean>;
  getTools?: () => any[];
}

const modules: BootstrapModule[] = [];

export function registerModule(module: BootstrapModule): void {
  modules.push(module);
}

export function getAllModuleTools(): any[] {
  const allTools: any[] = [];
  for (const module of modules) {
    if (module.getTools) {
      allTools.push(...module.getTools());
    }
  }
  return allTools;
}

export async function bootstrap(options: { force?: boolean } = {}): Promise<void> {
  logger.info("🚀 Iniciando Bootstrap HiveDB...");
  await ensureHiveDb();

  for (const module of modules) {
    try {
      if (module.initializeSchema) {
        await module.initializeSchema();
        logger.info(`[bootstrap] Schema de '${module.name}' inicializado`);
      }
      if (module.seedData) {
        await module.seedData(options.force);
        logger.info(`[bootstrap] Seed de '${module.name}' completado`);
      }
      if (module.validate) {
        if (await module.validate()) {
          logger.info(`[bootstrap] '${module.name}' validado correctamente`);
        }
      }
    } catch (err) {
      logger.error(`[bootstrap] Error en módulo '${module.name}':`, (err as Error).message);
    }
  }

  logger.info("✅ Bootstrap HiveDB completado con éxito");
}
