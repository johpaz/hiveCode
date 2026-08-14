import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  specKitArtifactReadTool,
  specKitArtifactWriteTool,
  specKitInitTool,
  specKitValidateTool,
} from "./index.ts"

const workspace = await mkdtemp(path.join(tmpdir(), "hive-speckit-"))
const config = { configurable: { workspace } }

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe("native Spec Kit tools", () => {
  test("initialize, write, read, and validate artifacts inside the workspace", async () => {
    const initialized = await specKitInitTool.execute(
      { objective: "Durable agent harness", feature_id: "durable-harness" },
      config,
    ) as any
    expect(initialized.ok).toBe(true)
    expect(initialized.feature_dir).toBe("specs/durable-harness")

    const content = `# Feature Specification

## User Scenarios & Testing

One independently testable scenario.

## Requirements

- FR-001: Persist run state.

## Success Criteria

- SC-001: A stopped task resumes.
`
    const written = await specKitArtifactWriteTool.execute({
      feature_dir: initialized.feature_dir,
      artifact: "spec",
      content,
    }, config) as any
    expect(written.ok).toBe(true)

    const read = await specKitArtifactReadTool.execute({
      feature_dir: initialized.feature_dir,
      artifact: "spec",
    }, config) as any
    expect(read.content).toContain("FR-001")

    const validated = await specKitValidateTool.execute({
      feature_dir: initialized.feature_dir,
      stage: "spec",
    }, config) as any
    expect(validated.valid).toBe(true)
  })

  test("rejects feature paths outside specs", async () => {
    const result = await specKitArtifactReadTool.execute({
      feature_dir: "../outside",
      artifact: "spec",
    }, config) as any
    expect(result.ok).toBe(false)
  })
})
