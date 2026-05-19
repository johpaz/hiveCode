import { SCHEMA, PROJECTS_SCHEMA, CONTEXT_ENGINE_SCHEMA, MEETING_SCHEMA } from "./schema";
import { logger } from "../utils/logger";
import { seedAllData } from "./seed";

const log = logger.child("core-init");

export const CoreModule: BootstrapModule = {
  name: "core",
  initializeSchema: (db: Database) => {
    log.info("🗄️  Inicializando esquemas base...");
    db.run(SCHEMA);
    db.run(PROJECTS_SCHEMA);
    db.run(CONTEXT_ENGINE_SCHEMA);
    db.run(MEETING_SCHEMA);
    ensureSchemaSync(db);
  },
  seedData: (_, force) => {
    seedAllData(force);
  }
};

function ensureColumnExists(db: Database, tableName: string, columnName: string, columnDefinition: string): void {
  try {
    const info = db.query(`PRAGMA table_info(${tableName})`).all() as any[];
    const exists = info.some((col: any) => col.name === columnName);

    if (!exists) {
      log.info(`🛠️  Añadiendo columna faltante '${columnName}' a la tabla '${tableName}'`);
      db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    }
  } catch (err) {
    log.warn(`⚠️  No se pudo verificar columna '${columnName}' en '${tableName}':`, (err as Error).message);
  }
}

function ensureSchemaSync(db: Database): void {
  // Sync users
  ensureColumnExists(db, "users", "email", "TEXT");
  ensureColumnExists(db, "users", "password_hash", "TEXT");

  // Sync mcp_servers
  ensureColumnExists(db, "mcp_servers", "tools_count", "INTEGER DEFAULT 0");
  ensureColumnExists(db, "mcp_servers", "status", "TEXT NOT NULL DEFAULT 'disconnected'");

  // Sync providers
  ensureColumnExists(db, "providers", "api_key_encrypted", "TEXT");
  ensureColumnExists(db, "providers", "api_key_iv", "TEXT");
  ensureColumnExists(db, "providers", "num_ctx", "INTEGER");

  // Sync agents
  ensureColumnExists(db, "agents", "role", "TEXT NOT NULL DEFAULT 'coordinator'");
  ensureColumnExists(db, "agents", "workspace", "TEXT");

  // Sync tasks
  ensureColumnExists(db, "tasks", "priority", "INTEGER NOT NULL DEFAULT 0");
  ensureColumnExists(db, "tasks", "error", "TEXT");

  // Context Engine
  ensureColumnExists(db, "conversations", "reasoning_content", "TEXT");

  // Sync migrations (optional but good for tracking)
  db.query(`INSERT OR IGNORE INTO schema_migrations (version) VALUES ('0.0.30')`).run();
}
