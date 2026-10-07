import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { getHiveDbPath } from "./hivedb";

/**
 * The default was `<cwd>/hivecode`, which meant a different directory was a
 * different — and empty — installation. These tests pin the replacement: the
 * database follows the HiveDir, like every other piece of persistent state.
 */
describe("getHiveDbPath", () => {
  test("defaults to the HiveDir, not the working directory", () => {
    expect(getHiveDbPath({}, "/workspace/project")).toBe(
      path.join(os.homedir(), ".hivecode", "data", "hivedb"),
    );
  });

  test("the default is identical from any working directory", () => {
    expect(getHiveDbPath({}, "/workspace/project")).toBe(
      getHiveDbPath({}, "/somewhere/else"),
    );
  });

  test("keeps HIVE_DB_PATH as an explicit override", () => {
    expect(getHiveDbPath({ HIVE_DB_PATH: "./custom-db" }, "/workspace/project")).toBe(
      path.resolve("/workspace/project", "custom-db"),
    );
  });

  test("HIVE_DEV does not move the database", () => {
    // `bun run dev` sets it; giving dev its own database meant a second, empty
    // one appearing inside the repo.
    expect(getHiveDbPath({ HIVE_DEV: "true" }, "/workspace/project")).toBe(
      getHiveDbPath({}, "/workspace/project"),
    );
  });

  test("HIVE_HOME places the database beside the rest of the HiveDir", () => {
    expect(getHiveDbPath({ HIVE_HOME: "/opt/hive" })).toBe("/opt/hive/data/hivedb");
  });
});