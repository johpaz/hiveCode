import { describe, expect, test } from "bun:test"
import { structuralParallelism } from "./swarm-capabilities"

const call = (name: string, args: Record<string, unknown> = {}) => ({ function: { name, arguments: JSON.stringify(args) } })

describe("structuralParallelism", () => {
  test("a batch of searches, AST and git reads runs in parallel", async () => {
    const out = await structuralParallelism([
      call("search_in_files", { pattern: "x", path: "." }),
      call("fs_read", { path: "a.ts" }),
      call("parse_ast", { path: "a.ts" }),
      call("git_status"),
    ])
    expect(out).toEqual({ kind: "reads", safe: true })
  })

  test("a search next to a write is not batched: it may see the write", async () => {
    const out = await structuralParallelism([
      call("fs_edit", { path: "a.ts", oldString: "a", newString: "b" }),
      call("search_in_files", { pattern: "a", path: "." }),
    ])
    expect(out).toEqual({ kind: "writes", safe: false })
  })

  test("writes to distinct files stay parallel", async () => {
    const out = await structuralParallelism([
      call("fs_edit", { path: "a.ts", oldString: "a", newString: "b" }),
      call("fs_write", { path: "b.ts", content: "" }),
    ])
    expect(out).toEqual({ kind: "writes", safe: true })
  })

  test("a shell command still serializes the batch", async () => {
    const out = await structuralParallelism([call("fs_read", { path: "a.ts" }), call("shell_executor", { command: "ls" })])
    expect(out).toBeUndefined()
  })
})
