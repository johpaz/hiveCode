import type { ChildLogger } from "../../utils/logger";

/** Preserve the previous contents before an edit or overwrite. */
export async function backupIfExists(filePath: string, log: Pick<ChildLogger, "debug" | "warn">): Promise<string | null> {
  try {
    if (!await Bun.file(filePath).exists()) return null;
    const backup = `${filePath}.hive-bak.${Date.now()}`;
    await Bun.write(backup, Bun.file(filePath));
    log.debug(`Backup created: ${backup}`);
    return backup;
  } catch {
    log.warn(`Backup failed for ${filePath}, proceeding without backup`);
    return null;
  }
}
