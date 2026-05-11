import type { Tool } from "../types.ts"

// ─── Git Status ──────────────────────────────────────────────────────────────

const gitStatusTool: Tool = {
  name: "git_status",
  description: "Show working tree status (git status --porcelain). Returns changed, staged, and untracked files. Spanish keywords: estado git, cambios, staged, repositorio, git status",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to git repository (default: workspace)",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    try {
      const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd: path })
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        return { ok: false, error: stderr, hint: "Verify this is a git repository" }
      }
      const lines = output.split("\n").filter(Boolean)
      const staged = lines.filter(l => l.startsWith("M") || l.startsWith("A") || l.startsWith("D") || l.startsWith("R") || l.startsWith("C"))
      const unstaged = lines.filter(l => l.startsWith(" M") || l.startsWith(" D") || l.startsWith("??"))
      return {
        ok: true,
        result: {
          summary: `${staged.length} staged, ${unstaged.length} unstaged/untracked`,
          staged: staged.map(l => l.substring(3)),
          unstaged: unstaged.map(l => l.substring(3)),
          raw: output,
        },
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Git Diff ────────────────────────────────────────────────────────────────

const gitDiffTool: Tool = {
  name: "git_diff",
  description: "Show changes in working tree or between commits (git diff). Spanish keywords: ver cambios, diff, comparar, diferencias git",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to git repository (default: workspace)",
      },
      staged: {
        type: "boolean",
        description: "Show staged changes (--cached)",
      },
      target: {
        type: "string",
        description: "Compare against a branch or commit (e.g., main, HEAD~1)",
      },
      file: {
        type: "string",
        description: "Specific file to diff",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    const args = ["diff"]
    if (params.staged) args.push("--cached")
    if (params.target) args.push(params.target as string)
    if (params.file) args.push(params.file as string)
    try {
      const proc = Bun.spawn(["git", ...args], { cwd: path })
      const output = await new Response(proc.stdout).text()
      return { ok: true, result: { diff: output, length: output.length } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Git Log ─────────────────────────────────────────────────────────────────

const gitLogTool: Tool = {
  name: "git_log",
  description: "Show commit history (git log). Spanish keywords: historial commits, ver commits, log git, historial git",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to git repository (default: workspace)",
      },
      count: {
        type: "number",
        description: "Number of commits to show (default: 10)",
      },
      branch: {
        type: "string",
        description: "Filter by branch",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    const count = (params.count as number) || 10
    const args = ["log", `--max-count=${count}`, "--format=%h %ai %an: %s"]
    if (params.branch) args.unshift(params.branch as string)
    try {
      const proc = Bun.spawn(["git", ...args], { cwd: path })
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        return { ok: false, error: await new Response(proc.stderr).text() }
      }
      const commits = output.split("\n").filter(Boolean).map(line => {
        const [hash, date, time, ...rest] = line.split(" ")
        return { hash, date: `${date} ${time}`, message: rest.join(" ") }
      })
      return { ok: true, result: { commits, count: commits.length } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Git Branch ──────────────────────────────────────────────────────────────

const gitBranchTool: Tool = {
  name: "git_branch",
  description: "List, create, or delete git branches. Spanish keywords: ramas git, branch, crear rama, listar ramas",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to git repository (default: workspace)",
      },
      action: {
        type: "string",
        enum: ["list", "create", "delete", "switch"],
        description: "Branch action (default: list)",
      },
      name: {
        type: "string",
        description: "Branch name (for create/delete/switch)",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    const action = (params.action as string) || "list"
    try {
      if (action === "list") {
        const proc = Bun.spawn(["git", "branch", "-a"], { cwd: path })
        const output = await new Response(proc.stdout).text()
        const branches = output.split("\n").filter(Boolean).map(b => b.trim())
        return { ok: true, result: { branches, current: branches.find(b => b.startsWith("*"))?.replace("* ", "") } }
      }
      if (action === "create" && params.name) {
        const proc = Bun.spawn(["git", "branch", params.name as string], { cwd: path })
        await proc.exited
        return { ok: true, result: `Branch '${params.name}' created` }
      }
      if (action === "delete" && params.name) {
        const proc = Bun.spawn(["git", "branch", "-d", params.name as string], { cwd: path })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
          return { ok: false, error: await new Response(proc.stderr).text(), hint: "Try -D for force delete" }
        }
        return { ok: true, result: `Branch '${params.name}' deleted` }
      }
      if (action === "switch" && params.name) {
        const proc = Bun.spawn(["git", "checkout", params.name as string], { cwd: path })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
          return { ok: false, error: await new Response(proc.stderr).text() }
        }
        return { ok: true, result: `Switched to branch '${params.name}'` }
      }
      return { ok: false, error: "Invalid action or missing branch name" }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Git Commit ──────────────────────────────────────────────────────────────

const gitCommitTool: Tool = {
  name: "git_commit",
  description: "Stage files and create a git commit. Spanish keywords: commit, confirmar cambios, git commit, staged",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to git repository (default: workspace)",
      },
      message: {
        type: "string",
        description: "Commit message",
      },
      files: {
        type: "string",
        description: "Files to stage (space-separated, default: all changes)",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    const message = params.message as string
    if (!message) return { ok: false, error: "Commit message is required" }
    try {
      if (params.files) {
        const files = (params.files as string).split(" ")
        const addProc = Bun.spawn(["git", "add", ...files], { cwd: path })
        await addProc.exited
      } else {
        const addProc = Bun.spawn(["git", "add", "-A"], { cwd: path })
        await addProc.exited
      }
      const proc = Bun.spawn(["git", "commit", "-m", message], { cwd: path })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      return {
        ok: exitCode === 0,
        result: exitCode === 0 ? { message: stdout.trim() } : undefined,
        error: exitCode !== 0 ? (stderr || stdout) : undefined,
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Code Search ─────────────────────────────────────────────────────────────

const codeSearchTool: Tool = {
  name: "code_search",
  description: "Search codebase for patterns using ripgrep or grep. Finds function definitions, variable usage, imports, etc. Spanish keywords: buscar codigo, buscar funcion, grep, encontrar en codigo, buscar patron",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Search pattern (regex supported)",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: workspace)",
      },
      include: {
        type: "string",
        description: "File pattern to include (e.g., *.ts, *.js, *.rs)",
      },
      maxResults: {
        type: "number",
        description: "Maximum results to return (default: 30)",
      },
      context: {
        type: "number",
        description: "Lines of context before/after match (default: 2)",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    const pattern = params.pattern as string
    if (!pattern) return { ok: false, error: "Search pattern is required" }
    const maxResults = (params.maxResults as number) || 30
    const context = (params.context as number) || 2
    try {
      const rgProc = Bun.spawn([
        "rg", "--line-number", "--with-filename",
        `--context=${context}`, `--max-count=${maxResults}`,
        ...(params.include ? ["--glob", params.include as string] : []),
        pattern, path,
      ])
      const stdout = await new Response(rgProc.stdout).text()
      const exitCode = await rgProc.exited
      if (exitCode === 1) return { ok: true, result: { matches: [], count: 0 } }
      if (exitCode !== 0) {
        const stderr = await new Response(rgProc.stderr).text()
        return { ok: false, error: stderr, hint: "Try a simpler pattern or check if ripgrep is installed" }
      }
      const lines = stdout.split("\n").filter(Boolean)
      return { ok: true, result: { matches: lines.slice(0, maxResults * (context * 2 + 1)), count: lines.length } }
    } catch {
      try {
        const grepProc = Bun.spawn([
          "grep", "-rn", "--include", params.include as string || "*.ts",
          pattern, path,
        ])
        const stdout = await new Response(grepProc.stdout).text()
        return { ok: true, result: { matches: stdout.split("\n").filter(Boolean).slice(0, maxResults), count: stdout.split("\n").length, note: "Used grep (rg not available)" } }
      } catch (err2) {
        return { ok: false, error: (err2 as Error).message }
      }
    }
  },
}

// ─── Code Build ──────────────────────────────────────────────────────────────

const codeBuildTool: Tool = {
  name: "code_build",
  description: "Run build command for the project. Detects package.json scripts automatically. Spanish keywords: compilar, build, construir proyecto, npm run build, bun run build",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Project directory (default: workspace)",
      },
      command: {
        type: "string",
        description: "Build command override (e.g., 'npm run build', 'cargo build')",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 120)",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    let cmd = params.command as string
    if (!cmd) {
      const pkg = Bun.file(`${path}/package.json`)
      if (await pkg.exists()) {
        const pkgJson = await pkg.json()
        cmd = pkgJson.scripts?.build ? "npm run build" : "bun run build"
      } else {
        cmd = "make"
      }
    }
    try {
      const proc = Bun.spawn(["/bin/sh", "-c", cmd], {
        cwd: path,
        timeout: ((params.timeout as number) || 120) * 1000,
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      return {
        ok: exitCode === 0,
        result: exitCode === 0 ? { output: stdout } : undefined,
        error: exitCode !== 0 ? (stderr || stdout).substring(0, 2000) : undefined,
        hint: exitCode !== 0 ? "Build failed. Check the error output above." : undefined,
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Code Test ───────────────────────────────────────────────────────────────

const codeTestTool: Tool = {
  name: "code_test",
  description: "Run test suites. Detects package.json test scripts and common test frameworks. Spanish keywords: ejecutar tests, pruebas, test, npm test, bun test",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Project directory (default: workspace)",
      },
      command: {
        type: "string",
        description: "Test command override (e.g., 'bun test', 'npm test', 'cargo test')",
      },
      filter: {
        type: "string",
        description: "Test name pattern filter (for jest, vitest: -t flag)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 180)",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    let cmd = params.command as string
    if (!cmd) {
      const pkg = Bun.file(`${path}/package.json`)
      if (await pkg.exists()) {
        const pkgJson = await pkg.json()
        if (pkgJson.scripts?.test) cmd = pkgJson.scripts.test
        else cmd = "bun test"
      } else {
        cmd = "cargo test"
      }
    }
    if (params.filter) cmd += ` -t "${params.filter}"`
    try {
      const proc = Bun.spawn(["/bin/sh", "-c", cmd], {
        cwd: path,
        timeout: ((params.timeout as number) || 180) * 1000,
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      return {
        ok: exitCode === 0,
        result: { output: stdout, failed: exitCode !== 0 },
        error: exitCode !== 0 ? (stderr || stdout).substring(0, 2000) : undefined,
        hint: exitCode !== 0 ? "Tests failed. Review the output above." : undefined,
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Code Lint ───────────────────────────────────────────────────────────────

const codeLintTool: Tool = {
  name: "code_lint",
  description: "Run linter on codebase. Auto-detects ESLint, Ruff, or custom lint commands. Spanish keywords: linter, lint, revisar codigo, eslint, ruff, calidad codigo",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Project directory (default: workspace)",
      },
      command: {
        type: "string",
        description: "Lint command override (e.g., 'eslint src/', 'ruff check .')",
      },
      fix: {
        type: "boolean",
        description: "Auto-fix issues if supported",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 120)",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    let cmd = params.command as string
    if (!cmd) {
      const pkg = Bun.file(`${path}/package.json`)
      if (await pkg.exists()) {
        const pkgJson = await pkg.json()
        if (pkgJson.scripts?.lint) cmd = pkgJson.scripts.lint
        else cmd = "bunx eslint src/"
      } else {
        cmd = "ruff check ."
      }
    }
    if (params.fix && !cmd.includes("--fix")) cmd += " --fix"
    try {
      const proc = Bun.spawn(["/bin/sh", "-c", cmd], {
        cwd: path,
        timeout: ((params.timeout as number) || 120) * 1000,
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      return {
        ok: true,
        result: {
          output: stdout || stderr,
          issues: stdout.split("\n").filter(l => l.includes("error") || l.includes("warning") || l.includes("problem")).length,
          exitCode,
        },
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Code Diff Create ────────────────────────────────────────────────────────

const codeDiffCreateTool: Tool = {
  name: "code_diff_create",
  description: "Generate a unified diff between two files or versions. Useful for code review and patches. Spanish keywords: crear diff, parche, diferencia archivos, patch",
  parameters: {
    type: "object",
    properties: {
      file1: {
        type: "string",
        description: "Original file path",
      },
      file2: {
        type: "string",
        description: "Modified file path (or git ref:branch:path)",
      },
    },
  },
  async execute(params) {
    const file1 = params.file1 as string
    const file2 = params.file2 as string
    if (!file1 || !file2) return { ok: false, error: "Both file1 and file2 are required" }
    try {
      const proc = Bun.spawn(["diff", "-u", file1, file2])
      const stdout = await new Response(proc.stdout).text()
      return {
        ok: true,
        result: {
          diff: stdout,
          hasChanges: stdout.length > 0,
        },
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Parse AST ────────────────────────────────────────────────────────────────

const parseAstTool: Tool = {
  name: "parse_ast",
  description: "Analyze a TypeScript/JavaScript file's AST using Bun.Transpiler. Returns imports, exports, functions, classes, and complexity metrics. Spanish keywords: analizar ast, parsear codigo, analisis estatico, estructura archivo",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to analyze",
      },
    },
    required: ["path"],
  },
  async execute(params) {
    const filePath = params.path as string
    if (!filePath) return { ok: false, error: "File path is required" }
    try {
      const file = Bun.file(filePath)
      if (!(await file.exists())) return { ok: false, error: `File not found: ${filePath}` }
      const source = await file.text()

      const parser = new Bun.Transpiler({ loader: "ts" })

      const imports = parser.scan(source)
      const importRecords = imports?.imports?.map((i: any) => ({
        path: i.path,
        kind: i.kind,
        names: i.names?.map((n: any) => ({ name: n.name, alias: n.alias })),
      })) ?? []

      const exports = parser.scan(source)
      const exportRecords = exports?.exports?.map((e: any) => ({
        name: e.name,
        kind: e.kind,
      })) ?? []

      const lines = source.split("\n")
      const funcMatches = source.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g) ?? []
      const classMatches = source.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g) ?? []
      const interfaceMatches = source.match(/(?:export\s+)?interface\s+(\w+)/g) ?? []

      const functions = funcMatches.map(m => m.replace(/^(?:export\s+)?(?:async\s+)?function\s+/, ""))
      const classes = classMatches.map(m => m.replace(/^(?:export\s+)?(?:abstract\s+)?class\s+/, ""))
      const interfaces = interfaceMatches.map(m => m.replace(/^(?:export\s+)?interface\s+/, ""))

      const branchCount = (source.match(/\bif\s*\(/g) ?? []).length +
        (source.match(/\bswitch\s*\(/g) ?? []).length +
        (source.match(/\bfor\s*\(/g) ?? []).length +
        (source.match(/\bwhile\s*\(/g) ?? []).length +
        (source.match(/\bcatch\s*\(/g) ?? []).length +
        (source.match(/\?\s+/g) ?? []).length +
        (source.match(/\belse\s+if\b/g) ?? []).length

      return {
        ok: true,
        result: {
          path: filePath,
          size: source.length,
          lines: lines.length,
          imports: importRecords,
          exports: exportRecords,
          functions,
          classes,
          interfaces,
          complexity: {
            cyclomatic: branchCount + 1,
            branches: branchCount,
            functions: functions.length,
            classes: classes.length,
          },
        },
      }
    } catch (err) {
      return { ok: false, error: `AST parse failed: ${(err as Error).message}` }
    }
  },
}

// ─── Check Types ──────────────────────────────────────────────────────────────

const checkTypesTool: Tool = {
  name: "check_types",
  description: "Run TypeScript type checking (bun tsc --noEmit) on the project. Returns errors, warnings, and duration. Spanish keywords: revisar tipos, typecheck, tsc, errores typescript, validar tipos",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Project directory (default: workspace)",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 120)",
      },
    },
  },
  async execute(params) {
    const path = (params.path as string) || "."
    try {
      const start = Bun.nanoseconds()
      const proc = Bun.spawn(["bun", "tsc", "--noEmit"], {
        cwd: path,
        timeout: ((params.timeout as number) || 120) * 1000,
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      const durationNs = Bun.nanoseconds() - start

      const allOutput = stdout || stderr
      const errors = allOutput.split("\n")
        .filter(l => l.includes("error TS"))
        .map(l => ({ message: l.trim() }))
      const warnings = allOutput.split("\n")
        .filter(l => (l.includes("warning") || l.includes("@types")) && !l.includes("error"))
        .map(l => ({ message: l.trim() }))
      const fileCount = new Set(
        allOutput.split("\n")
          .filter(l => l.includes(".ts(") || l.includes(".tsx("))
          .map(l => l.split("(")[0])
      ).size

      return {
        ok: true,
        result: {
          pass: exitCode === 0,
          errors,
          warnings,
          duration: { ns: durationNs, ms: Math.round(durationNs / 1_000_000) },
          filesWithErrors: fileCount,
          summary: exitCode === 0
            ? "No type errors found"
            : `${errors.length} error(s), ${warnings.length} warning(s) in ${fileCount} file(s)`,
        },
      }
    } catch (err) {
      return { ok: false, error: `Type check failed: ${(err as Error).message}` }
    }
  },
}

// ─── Run Script ───────────────────────────────────────────────────────────────

const runScriptTool: Tool = {
  name: "run_script",
  description: "Execute a TypeScript/JavaScript file in an isolated subprocess with 60s timeout. Returns stdout, stderr, exit code, and duration. Spanish keywords: ejecutar script, correr archivo ts, run typescript, ejecutar codigo",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the script file to execute",
      },
      args: {
        type: "string",
        description: "Space-separated arguments to pass to the script",
      },
    },
    required: ["path"],
  },
  async execute(params) {
    const filePath = params.path as string
    if (!filePath) return { ok: false, error: "Script path is required" }
    try {
      const file = Bun.file(filePath)
      if (!(await file.exists())) return { ok: false, error: `Script not found: ${filePath}` }
      const args = [filePath]
      if (params.args) args.push(...(params.args as string).split(" "))
      const start = Bun.nanoseconds()
      const proc = Bun.spawn(["bun", ...args], {
        cwd: process.cwd(),
        timeout: 60_000,
        env: { ...process.env, NODE_ENV: "isolated" },
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited
      const durationNs = Bun.nanoseconds() - start
      return {
        ok: true,
        result: {
          stdout,
          stderr,
          exitCode,
          duration: { ns: durationNs, ms: Math.round(durationNs / 1_000_000) },
          truncated: stdout.length > 100_000 || stderr.length > 100_000,
        },
      }
    } catch (err) {
      return { ok: false, error: `Script execution failed: ${(err as Error).message}` }
    }
  },
}

// ─── Git Blame ────────────────────────────────────────────────────────────────

const gitBlameTool: Tool = {
  name: "git_blame",
  description: "Show authorship information for a file or specific lines (git blame). Spanish keywords: blame, autor, quien escribio, autoría, git blame, lines",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to git repository (default: workspace)",
      },
      file: {
        type: "string",
        description: "File path relative to repository root",
      },
      lineStart: {
        type: "number",
        description: "Starting line number (1-indexed, optional)",
      },
      lineEnd: {
        type: "number",
        description: "Ending line number (optional)",
      },
    },
    required: ["file"],
  },
  async execute(params) {
    const repoPath = (params.path as string) || "."
    const file = params.file as string
    if (!file) return { ok: false, error: "File path is required" }
    try {
      const args = ["blame", "--line-porcelain"]
      if (params.lineStart) {
        const end = params.lineEnd ? `,${params.lineEnd}` : ""
        args.push(`-L${params.lineStart}${end}`)
      }
      args.push(file)
      const proc = Bun.spawn(["git", ...args], { cwd: repoPath })
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        return { ok: false, error: await new Response(proc.stderr).text() }
      }
      const lines = output.split("\n").filter(Boolean)
      const authors = new Map<string, { count: number; lines: number[] }>()
      let currentLine = 0
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        if (l.startsWith("author ")) {
          const author = l.slice(7)
          if (!authors.has(author)) authors.set(author, { count: 0, lines: [] })
          authors.get(author)!.count++
          if (currentLine > 0) authors.get(author)!.lines.push(currentLine)
        }
        if (l.match(/^[a-f0-9]{40}\s/)) {
          currentLine++
        }
      }
      const authorSummary = Array.from(authors.entries())
        .map(([author, info]) => ({ author, lines: info.count, lineNumbers: info.lines }))
        .sort((a, b) => b.lines - a.lines)
      return {
        ok: true,
        result: {
          file,
          authors: authorSummary,
          totalLines: currentLine,
          raw: output.slice(0, 5000),
        },
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  },
}

// ─── Git Create PR ────────────────────────────────────────────────────────────

const gitCreatePrTool: Tool = {
  name: "git_create_pr",
  description: "Create a GitHub Pull Request using the GitHub API. Uses GITHUB_TOKEN from env or Bun.secrets. The body can include narrative formatted as Markdown. Spanish keywords: crear pr, pull request, github pr, abrir pr",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "PR title",
      },
      body: {
        type: "string",
        description: "PR body in Markdown (optional, auto-generated from commit log if omitted)",
      },
      head: {
        type: "string",
        description: "Head branch name (default: current branch)",
      },
      base: {
        type: "string",
        description: "Base branch name (default: main)",
      },
      repo: {
        type: "string",
        description: "Repository in owner/repo format (default: detected from git remote)",
      },
      path: {
        type: "string",
        description: "Path to git repository (default: workspace)",
      },
    },
    required: ["title"],
  },
  async execute(params) {
    const repoPath = (params.path as string) || "."
    const title = params.title as string
    if (!title) return { ok: false, error: "PR title is required" }

    let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
    if (!token) {
      try {
        const secrets = (Bun as any).secrets
        token = secrets?.GITHUB_TOKEN || secrets?.GH_TOKEN || ""
      } catch {}
    }
    if (!token) {
      const ghProc = Bun.spawn(["gh", "auth", "token"], { cwd: repoPath })
      token = (await new Response(ghProc.stdout).text()).trim()
    }

    try {
      let repo = params.repo as string
      if (!repo) {
        const remoteProc = Bun.spawn(["git", "remote", "get-url", "origin"], { cwd: repoPath })
        const remote = (await new Response(remoteProc.stdout).text()).trim()
        const match = remote.match(/(?:github\.com[/:])([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
        if (match) repo = `${match[1]}/${match[2]}`
        else return { ok: false, error: "Could not detect GitHub repository from git remote" }
      }

      let head = params.head as string
      if (!head) {
        const branchProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath })
        head = (await new Response(branchProc.stdout).text()).trim()
      }
      const base = (params.base as string) || "main"

      let body = params.body as string
      if (!body) {
        const logProc = Bun.spawn(["git", "log", `${base}..${head}`, "--oneline", "--no-decorate"], { cwd: repoPath })
        const log = (await new Response(logProc.stdout).text()).trim()
        if (log) {
          const commits = log.split("\n").map(l => `- ${l}`).join("\n")
          body = `## Changes\n\n${commits}\n\n---\n*Auto-generated by Hive-Code*`
        } else {
          body = "*Auto-generated by Hive-Code*"
        }
      }

      const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "hive-code",
        },
        body: JSON.stringify({ title, body, head, base }),
      })
      const data = await response.json()
      if (!response.ok) {
        return { ok: false, error: data.message || `GitHub API error: ${response.status}`, hint: data.errors?.[0]?.message }
      }
      return {
        ok: true,
        result: {
          url: data.html_url,
          number: data.number,
          state: data.state,
          title: data.title,
          repo,
        },
      }
    } catch (err) {
      return { ok: false, error: `Failed to create PR: ${(err as Error).message}` }
    }
  },
}

// ─── Git Rollback ─────────────────────────────────────────────────────────────

const gitRollbackTool: Tool = {
  name: "git_rollback",
  description: "Restore file snapshots from SQLite and reset git to the state before a specific task. Requires user confirmation before execution. Spanish keywords: revertir tarea, restaurar snapshots, rollback, deshacer cambios, git reset",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Task ID to rollback to pre-task state",
      },
      path: {
        type: "string",
        description: "Path to git repository (default: workspace)",
      },
      dryRun: {
        type: "boolean",
        description: "Preview what would be restored without applying changes (default: true for safety)",
      },
      confirmed: {
        type: "boolean",
        description: "Must be explicitly set to true to execute the rollback",
      },
    },
    required: ["taskId"],
  },
  async execute(params) {
    const taskId = params.taskId as string
    const repoPath = (params.path as string) || "."
    const dryRun = params.dryRun !== false
    const confirmed = params.confirmed === true

    if (!dryRun && !confirmed) {
      return {
        ok: false,
        error: "Rollback requires explicit confirmation",
        hint: "Set confirmed=true and dryRun=false to execute the rollback. Use dryRun=true first to preview changes.",
      }
    }

    try {
      const { getDb } = await import("../../storage/sqlite.ts")
      const db = getDb()
      const snapshots = db.query(
        "SELECT * FROM code_file_snapshots WHERE task_id = ? ORDER BY id"
      ).all(taskId) as any[]

      if (snapshots.length === 0) {
        return { ok: false, error: `No snapshots found for task: ${taskId}` }
      }

      const taskInfo = db.query(
        "SELECT description, branch_name FROM code_tasks WHERE id = ?"
      ).get(taskId) as { description: string; branch_name: string | null } | undefined

      if (dryRun) {
        return {
          ok: true,
          result: {
            dryRun: true,
            taskId,
            taskDescription: taskInfo?.description ?? "Unknown task",
            branch: taskInfo?.branch_name ?? null,
            filesToRestore: snapshots.map((s: any) => ({
              filePath: s.file_path,
              hash: s.hash,
              snapshotAt: s.snapshot_at,
            })),
            totalFiles: snapshots.length,
            hint: "Run with dryRun=false & confirmed=true to execute rollback",
          },
        }
      }

      const branchName = taskInfo?.branch_name
      for (const snap of snapshots) {
        const fullPath = snap.file_path
        Bun.write(fullPath, snap.content)
      }

      const resetArgs = ["reset", "--hard"]
      if (branchName) {
        const mergeBase = Bun.spawn(["git", "merge-base", branchName, "main"], { cwd: repoPath })
        const baseSha = (await new Response(mergeBase.stdout).text()).trim()
        if (baseSha) resetArgs.push(baseSha)
      }
      const resetProc = Bun.spawn(["git", ...resetArgs], { cwd: repoPath })
      await resetProc.exited

      if (branchName) {
        Bun.spawn(["git", "branch", "-D", branchName], { cwd: repoPath })
      }

      db.query("DELETE FROM code_file_snapshots WHERE task_id = ?").run(taskId)
      db.query("UPDATE code_tasks SET status = 'rolled_back' WHERE id = ?").run(taskId)

      return {
        ok: true,
        result: {
          dryRun: false,
          taskId,
          taskDescription: taskInfo?.description ?? "Unknown task",
          branch: branchName ?? null,
          filesRestored: snapshots.length,
          branchDeleted: !!branchName,
        },
      }
    } catch (err) {
      return { ok: false, error: `Rollback failed: ${(err as Error).message}` }
    }
  },
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function createTools(): Tool[] {
  return [
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitBranchTool,
    gitCommitTool,
    codeSearchTool,
    codeBuildTool,
    codeTestTool,
    codeLintTool,
    codeDiffCreateTool,
    parseAstTool,
    checkTypesTool,
    runScriptTool,
    gitBlameTool,
    gitCreatePrTool,
    gitRollbackTool,
  ]
}

export {
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitBranchTool,
  gitCommitTool,
  codeSearchTool,
  codeBuildTool,
  codeTestTool,
  codeLintTool,
  codeDiffCreateTool,
  parseAstTool,
  checkTypesTool,
  runScriptTool,
  gitBlameTool,
  gitCreatePrTool,
  gitRollbackTool,
}
