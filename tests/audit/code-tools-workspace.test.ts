import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTools, workingDirectory } from "../../packages/core/src/tools/code/index"

// Los workers de una tarea trabajan en un worktree aislado, pero estas herramientas ejecutaban en
// process.cwd(): el proyecto real. Un verifier escribió su informe con `cat > ...` en el proyecto
// del usuario y luego lo copió a mano al worktree; los tests de un builder corrían contra el árbol
// equivocado; `git commit` tocaba el repositorio del usuario.
const tools = Object.fromEntries(createTools().map(tool => [tool.name, tool]))
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString()

let project = ""   // el proyecto real, donde se lanzó el proceso
let worktree = ""  // el espacio aislado de la tarea
const previousCwd = process.cwd()
const config = () => ({ configurable: { workspace: worktree } })

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "hive-code-project-")))
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "hive-code-worktree-")))
  for (const dir of [project, worktree]) {
    git(dir, "init", "-q", "-b", "main")
    // La herramienta de commit usa la identidad del repositorio: que no dependa de la del equipo.
    git(dir, "config", "user.name", "t")
    git(dir, "config", "user.email", "t@t")
    writeFileSync(join(dir, "marca.txt"), dir === project ? "PROYECTO\n" : "WORKTREE\n")
    git(dir, "add", "-A")
    git(dir, "commit", "-q", "-m", "init")
  }
  process.chdir(project)
})

afterEach(() => process.chdir(previousCwd))

describe("code tools work in the task's workspace, not in the process directory", () => {
  test("workingDirectory resolves inside the workspace and refuses to leave it", () => {
    expect(workingDirectory(undefined, config())).toBe(worktree)
    expect(workingDirectory(".", config())).toBe(worktree)
    expect(workingDirectory("src", config())).toBe(join(worktree, "src"))
    expect(() => workingDirectory("../fuera", config())).toThrow()
    expect(() => workingDirectory(project, config())).toThrow()
    // Sin workspace configurado (un chat sin tarea) se conserva el comportamiento anterior.
    expect(workingDirectory(".", undefined)).toBe(".")
  })

  test("code_build runs in the worktree, and what it writes stays there", async () => {
    const result = await tools.code_build.execute({ command: "pwd; cat marca.txt; echo informe > informe.md" }, config()) as any

    expect(result.ok).toBe(true)
    expect(result.result.output).toContain(worktree)
    expect(result.result.output).toContain("WORKTREE")
    expect(existsSync(join(worktree, "informe.md"))).toBe(true)
    expect(existsSync(join(project, "informe.md"))).toBe(false)
  })

  test("code_test and code_lint run there too", async () => {
    for (const name of ["code_test", "code_lint"]) {
      const result = await tools[name].execute({ command: "pwd" }, config()) as any
      expect(JSON.stringify(result), name).toContain(worktree)
      expect(JSON.stringify(result), name).not.toContain(project)
    }
  })

  test("git tools act on the worktree's repository, not the user's", async () => {
    writeFileSync(join(worktree, "nuevo.txt"), "x\n")
    const status = await tools.git_status.execute({}, config()) as any
    expect(JSON.stringify(status)).toContain("nuevo.txt")

    await tools.git_commit.execute({ message: "en el worktree", files: "nuevo.txt" }, config())
    expect(git(worktree, "log", "--oneline")).toContain("en el worktree")
    expect(git(project, "log", "--oneline")).not.toContain("en el worktree")
  })

  test("a path outside the workspace is refused", async () => {
    await expect(Promise.resolve().then(() => tools.code_build.execute({ path: project, command: "pwd" }, config()))).rejects.toThrow()
    expect(existsSync(join(project, "informe.md"))).toBe(false)
  })

  test("run_script resolves the script and its cwd inside the workspace", async () => {
    mkdirSync(join(worktree, "scripts"))
    writeFileSync(join(worktree, "scripts", "donde.ts"), "console.log(process.cwd())\n")
    writeFileSync(join(project, "scripts-no-existe.ts"), "console.log('proyecto')\n")

    const result = await tools.run_script.execute({ path: "scripts/donde.ts" }, config()) as any

    expect(JSON.stringify(result)).toContain(worktree)
  })

  test("without a workspace the tools behave as before (process directory)", async () => {
    const result = await tools.code_build.execute({ command: "pwd" }) as any
    expect(result.result.output.trim()).toBe(project)
    expect(readFileSync(join(project, "marca.txt"), "utf-8")).toBe("PROYECTO\n")
  })
})
