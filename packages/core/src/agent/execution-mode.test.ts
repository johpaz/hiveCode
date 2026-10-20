import {describe, expect, test} from "bun:test"
import {callRequiresConfirmation, canExecuteTool, filterToolsByMode, shellCommandMutates} from "./execution-mode"

describe("planning tools", () => {
  test("planning may delegate and revise specialist research", () => {
    for (const tool of ["task_delegate", "task_revise", "task_status", "spawn_agent", "get_project_context", "fs_read", "web_search", "web_fetch", "speckit_init", "speckit_artifact_write", "speckit_validate"]) {
      expect(canExecuteTool(tool, "plan")).toBe(true)
    }
    expect(filterToolsByMode([{name: "task_delegate"}, {name: "fs_write"}], "plan")).toEqual([{name: "task_delegate"}])
  })
  test("delegation does not grant implementation permission in plan mode", () => {
    for (const tool of ["fs_write", "fs_edit", "fs_delete", "shell_executor", "code_test", "code_build", "git_commit", "git_push", "agent_create", "agent_archive", "task_delegate_code"]) {
      expect(canExecuteTool(tool, "plan")).toBe(false)
      expect(canExecuteTool(tool, "approval")).toBe(true)
      expect(canExecuteTool(tool, "auto")).toBe(true)
    }
  })
})

describe("canPromptForConfirmation", () => {
  test("never prompts inside the TUI, whatever stdin looks like", async () => {
    const { canPromptForConfirmation } = await import("./execution-mode")
    const previous = process.env.HIVECODE_TUI
    try {
      process.env.HIVECODE_TUI = "1"
      expect(canPromptForConfirmation()).toBe(false)
      delete process.env.HIVECODE_TUI
      expect(canPromptForConfirmation()).toBe(process.stdin.isTTY === true)
    } finally {
      if (previous === undefined) delete process.env.HIVECODE_TUI
      else process.env.HIVECODE_TUI = previous
    }
  })
})

describe("shell commands that need confirmation in approval mode", () => {
  test("commands that change files or history do", () => {
    for (const command of [
      "rm old.txt", "rm -rf build", "mv a b", "cp a b", "touch x", "chmod +x run.sh", "ln -s a b",
      "echo hola > hola.txt", "cat a >> b", "printf 'x' >out.txt", "sed -i 's/a/b/' f.ts", "perl -pi -e 's/a/b/' f",
      "tee out.txt", "git commit -m x", "git push origin main", "git reset --hard", "git checkout -- f",
      "git clean -fd", "git branch -D x", "find . -name '*.log' -delete", "find . -exec rm {} \;",
      "ls && rm old.txt", "bun test; rm -rf tmp", "cat f | tee g", "FOO=1 rm x", "sudo rm x",
      "/bin/rm x", "bash -c 'rm x'", "sh -c \"echo a > b\"", "xargs rm", "npm publish",
      "cat <<EOF > file.txt\nhola\nEOF",
    ]) expect(shellCommandMutates(command), command).toBe(true)
  })

  test("reading, testing and building do not", () => {
    for (const command of [
      "ls -la", "cat package.json", "git status", "git diff", "git log --oneline", "git branch", "git branch -a",
      "bun test", "bun run build", "bunx tsc --noEmit", "npm test", "bun install", "grep -rn foo src",
      "wc -c hola.txt && od -c hola.txt | head -3", "echo hola", "pwd", "node -v",
      "bun test 2>&1", "bun test 2>/dev/null", "ls > /dev/null", "cmd 1>&2", "[ a = b ]", "test -f x && echo ok",
      "sed -n '1,5p' f", "find . -name '*.ts'", "head -3 a.txt",
    ]) expect(shellCommandMutates(command), command).toBe(false)
  })

  test("only shell_executor is judged by its command; the file tools always ask", () => {
    expect(callRequiresConfirmation("shell_executor", JSON.stringify({ command: "rm x" }))).toBe(true)
    expect(callRequiresConfirmation("shell_executor", JSON.stringify({ command: "bun test" }))).toBe(false)
    expect(callRequiresConfirmation("shell_executor", { command: "git commit -m x" })).toBe(true)
    expect(callRequiresConfirmation("shell_executor", "not json: rm x")).toBe(true)
    // El parámetro real de shell_executor es `cmd`.
    expect(callRequiresConfirmation("shell_executor", JSON.stringify({ cmd: "echo nuevo > nuevo.txt" }))).toBe(true)
    expect(callRequiresConfirmation("shell_executor", JSON.stringify({ cmd: "bun test" }))).toBe(false)
    expect(callRequiresConfirmation("shell_executor", JSON.stringify({ timeout: 5 }))).toBe(true)
    expect(callRequiresConfirmation("fs_write", "{}")).toBe(true)
    expect(callRequiresConfirmation("fs_read", "{}")).toBe(false)
  })
})

describe("command-taking tools are judged like the shell", () => {
  test("code_build / code_test / code_lint with a writing command ask", () => {
    for (const tool of ["code_build", "code_test", "code_lint", "check_types"]) {
      expect(callRequiresConfirmation(tool, JSON.stringify({ command: "cat > informe.md <<'EOF'\nhola\nEOF" })), tool).toBe(true)
      expect(callRequiresConfirmation(tool, JSON.stringify({ command: "rm -rf dist" })), tool).toBe(true)
    }
  })

  test("their ordinary use does not", () => {
    expect(callRequiresConfirmation("code_build", JSON.stringify({}))).toBe(false)
    expect(callRequiresConfirmation("code_test", JSON.stringify({ path: "." }))).toBe(false)
    expect(callRequiresConfirmation("code_test", JSON.stringify({ command: "bun test tests/" }))).toBe(false)
    expect(callRequiresConfirmation("code_build", JSON.stringify({ command: "bun run build" }))).toBe(false)
    expect(callRequiresConfirmation("check_types", JSON.stringify({ command: "bunx tsc --noEmit" }))).toBe(false)
  })

  test("unreadable arguments ask", () => {
    expect(callRequiresConfirmation("code_build", "no es json")).toBe(true)
  })
})
