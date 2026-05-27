import { Database } from "bun:sqlite";
export type { Database };
import { logger } from "../utils/logger.ts";
import * as path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { getHiveDir } from "../config/loader.ts";


function getDbPath(): string {
    return path.join(getHiveDir(), "data", "hivecode.db");
}

export function getDbPathLazy(): string {
    return getDbPath();
}

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) throw new Error("DB no inicializada. Llama initializeDatabase() primero.");
  return _db;
}

export function _setDb(db: Database): void {
  _db = db;
}

export function _resetDb(): void {
  _db = null;
}


export function initializeDatabase(): Database {
    const hiveDir = getHiveDir();
    const dir = path.join(hiveDir, "data");
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const dbPath = getDbPath();
    _db = new Database(dbPath, { create: true });

    // ── Pragmas WAL y performance ──
    try {
        _db.run(`PRAGMA journal_mode = WAL`);
        _db.run(`PRAGMA synchronous = NORMAL`);
        _db.run(`PRAGMA cache_size = -64000`);      // 64 MB
        _db.run(`PRAGMA temp_store = MEMORY`);
        _db.run(`PRAGMA mmap_size = 268435456`);    // 256 MB
        _db.run(`PRAGMA foreign_keys = ON`);
        const jm = _db.query(`PRAGMA journal_mode`).get() as { journal_mode: string };
        logger.info(`🗄️  SQLite initialized — mode: ${jm?.journal_mode || "unknown"}, path: ${dbPath}`);
    } catch (pragmaErr) {
        logger.warn("⚠️  Failed to set SQLite pragmas:", (pragmaErr as Error).message);
    }

    return _db;
}


export class DatabaseService {
    private log = logger.child("sqlite");

    private get db(): Database {
        if (!_db) {
            initializeDatabase();
        }
        return _db!;
    }

    public close(): void {
        if (_db) {
            _db.close();
            _db = null;
        }
    }

    public updateMCPServer(id: string, updates: any): void {
        const fields = [];
        const values: any = { $id: id };

        if (updates.enabled !== undefined) {
            fields.push("enabled = $enabled");
            values.$enabled = updates.enabled ? 1 : 0;
        }
        if (updates.active !== undefined) {
            fields.push("active = $active");
            values.$active = updates.active ? 1 : 0;
        }
        if (updates.status !== undefined) {
            fields.push("status = $status");
            values.$status = updates.status;
        }
        if (updates.tools_count !== undefined) {
            fields.push("tools_count = $tools_count");
            values.$tools_count = updates.tools_count;
        }
        if (updates.transport !== undefined) {
            fields.push("transport = $transport");
            values.$transport = updates.transport;
        }
        if (updates.command !== undefined) {
            fields.push("command = $command");
            values.$command = updates.command;
        }
        if (updates.args !== undefined) {
            fields.push("args = $args");
            values.$args = JSON.stringify(updates.args);
        }
        if (updates.url !== undefined) {
            fields.push("url = $url");
            values.$url = updates.url;
        }
        if (updates.env_encrypted !== undefined) {
            fields.push("env_encrypted = $env_encrypted");
            values.$env_encrypted = updates.env_encrypted;
        }
        if (updates.env_iv !== undefined) {
            fields.push("env_iv = $env_iv");
            values.$env_iv = updates.env_iv;
        }
        if (updates.headers_encrypted !== undefined) {
            fields.push("headers_encrypted = $headers_encrypted");
            values.$headers_encrypted = updates.headers_encrypted;
        }
        if (updates.headers_iv !== undefined) {
            fields.push("headers_iv = $headers_iv");
            values.$headers_iv = updates.headers_iv;
        }

        if (fields.length === 0) return;

        const query = `UPDATE mcp_servers SET ${fields.join(", ")} WHERE id = $id`;
        try {
            this.db.query(query).run(values);
            this.log.debug(`MCP server ${id} updated in DB`);
        } catch (error: any) {
            this.log.error(`Failed to update MCP server ${id}: ${error.message}`);
        }
    }

    public getActiveAgentWorkspace(): string | null {
        try {
            const row = this.db.query(
                "SELECT workspace FROM agents WHERE role = 'coordinator' LIMIT 1"
            ).get() as { workspace: string } | null;
            const ws = row?.workspace;
            return ws && ws !== "null" ? ws : null;
        } catch {
            return null;
        }
    }

    public listMCPServers(): any[] {
        try {
            return this.db.query("SELECT * FROM mcp_servers").all();
        } catch (error: any) {
            this.log.error(`Failed to list MCP servers: ${error.message}`);
            return [];
        }
    }

    public createTask(task: {
        project_id: string;
        agent_id?: string | null;
        parent_task_id?: number | null;
        name: string;
        description?: string | null;
    }): number {
        const result = this.db.query(`
            INSERT INTO tasks (project_id, agent_id, parent_task_id, name, description)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            task.project_id,
            task.agent_id ?? null,
            task.parent_task_id ?? null,
            task.name,
            task.description ?? null
        );
        return Number(result.lastInsertRowid);
    }

    public updateTask(taskId: number, updates: {
        status?: string;
        progress?: number;
        result?: string;
        agent_id?: string | null;
    }): boolean {
        const fields: string[] = ["updated_at = unixepoch()"];
        const values: any[] = [];

        if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
        if (updates.progress !== undefined) { fields.push("progress = ?"); values.push(updates.progress); }
        if (updates.result !== undefined) { fields.push("result = ?"); values.push(updates.result); }
        if (updates.agent_id !== undefined) { fields.push("agent_id = ?"); values.push(updates.agent_id); }

        values.push(taskId);
        const res = this.db.query(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        return res.changes > 0;
    }

    public getTasksByProject(projectId: string): any[] {
        return this.db.query(
            "SELECT * FROM tasks WHERE project_id = ? ORDER BY id ASC"
        ).all(projectId) as any[];
    }

    public getProjectWithTasks(projectId: string): any | null {
        const project = this.db.query("SELECT * FROM projects WHERE id = ?").get(projectId) as any;
        if (!project) return null;
        project.tasks = this.getTasksByProject(projectId);
        return project;
    }

    public recalcProjectProgress(projectId: string): number {
        const row = this.db.query(
            "SELECT AVG(progress) as avg_progress FROM tasks WHERE project_id = ?"
        ).get(projectId) as any;
        const avg = Math.round(row?.avg_progress ?? 0);
        this.db.query("UPDATE projects SET progress = ?, updated_at = unixepoch() WHERE id = ?").run(avg, projectId);
        return avg;
    }

    public saveMCPServer(server: any): void {
        try {
            this.db.query(`
                INSERT OR REPLACE INTO mcp_servers (id, name, transport, command, args, url, env_encrypted, env_iv, headers_encrypted, headers_iv, enabled, active, builtin, tools_count, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                server.id || server.name,
                server.name,
                server.transport,
                server.command || null,
                JSON.stringify(server.args || []),
                server.url || null,
                server.env_encrypted || null,
                server.env_iv || null,
                server.headers_encrypted || null,
                server.headers_iv || null,
                server.enabled ? 1 : 0,
                server.active ? 1 : 0,
                server.builtin ? 1 : 0,
                server.tools_count || 0,
                server.status || "disconnected"
            );
        } catch (error: any) {
            this.log.error(`Failed to save MCP server ${server.name}: ${error.message}`);
        }
    }
}

export const dbService = new DatabaseService();
