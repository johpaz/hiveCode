import { describe, expect, test } from "bun:test";
import path from "node:path";
import { getHiveDbPath } from "./hivedb";

describe("getHiveDbPath", () => {
  test("stores HiveDB in ./hivecode by default", () => {
    expect(getHiveDbPath({}, "/workspace/project")).toBe(
      path.resolve("/workspace/project", "hivecode"),
    );
  });

  test("keeps HIVE_DB_PATH as an explicit override", () => {
    expect(getHiveDbPath({ HIVE_DB_PATH: "./custom-db" }, "/workspace/project")).toBe(
      path.resolve("/workspace/project", "custom-db"),
    );
  });
});
