/**
 * Code-quality metrics for a finished project, the same for every agent.
 *
 * Hidden tests say whether the code does what the contract asks; they say nothing about how it is
 * written. These are the measurable parts of that, read from the code with the TypeScript compiler:
 *
 *   - types:       errors under `strict`, with one fixed type environment (Bun's) for everybody, so an
 *                  agent is not penalised for what it did not install
 *   - size:        source lines (code, no blanks or comments), files, the longest file
 *   - functions:   how many, how long, and cyclomatic complexity (branches per function)
 *   - hygiene:     `any`, `@ts-ignore`, console calls left in source, empty `catch`, TODO/FIXME
 *   - duplication: share of 5-line blocks that appear more than once
 *   - tests:       how many and how many assertions each — what the agent wrote, not the hidden suite
 *   - weight:      declared dependencies
 *
 * None of these is a verdict by itself (fewer lines is not always better), and none judges naming or
 * design. They are for comparing agents on the same task, next to the hidden tests, not for ranking
 * code in the abstract.
 */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
// The compiler comes from this repository, so the numbers do not depend on what the agent installed.
const ts = require(join(ROOT, "node_modules/typescript")) as typeof import("typescript")

export interface CodeQuality {
  srcFiles: number
  srcSloc: number
  maxFileSloc: number
  testFiles: number
  testSloc: number
  tests: number
  assertions: number
  /** Share of lines that are comments, among comment and code lines. */
  commentRatio: number
  functions: number
  funcAvgLines: number
  funcMaxLines: number
  ccAvg: number
  ccMax: number
  /** Functions with cyclomatic complexity above 10. */
  ccOver10: number
  any: number
  tsIgnore: number
  consoleCalls: number
  emptyCatch: number
  todo: number
  /** Share of 5-line blocks of source that occur more than once, 0–1. */
  dupRatio: number
  /** Errors under `strict` in the source files. */
  strictErrors: number
  /** Errors under `strict` in the tests the agent wrote. */
  testStrictErrors: number
  deps: number
  devDeps: number
  hasTsconfig: boolean
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/
const TEST_FILE = /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|__tests__)\//
const IGNORED = /(?:^|\/)(?:node_modules|dist|build|coverage|\.git)\//

const FUNCTION_KINDS = new Set<number>([
  ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
])

interface FileFacts {
  sloc: number
  commentLines: number
  /** Normalised code lines, for the duplication count. */
  lines: string[]
  functions: Array<{ lines: number; cc: number }>
  any: number
  tsIgnore: number
  consoleCalls: number
  emptyCatch: number
  todo: number
  tests: number
  assertions: number
}

/** Lines that hold code and lines that hold only comments, read from the parsed tokens. */
function lineKinds(sf: import("typescript").SourceFile): { code: Set<number>; commentOnly: Set<number> } {
  const text = sf.text
  const code = new Set<number>()
  const comments = new Set<number>()
  const mark = (set: Set<number>, from: number, to: number) => {
    const first = sf.getLineAndCharacterOfPosition(from).line
    const last = sf.getLineAndCharacterOfPosition(Math.max(from, to - 1)).line
    for (let line = first; line <= last; line++) set.add(line)
  }
  const addComments = (ranges: import("typescript").CommentRange[] | undefined) => {
    for (const range of ranges ?? []) mark(comments, range.pos, range.end)
  }
  const visit = (node: import("typescript").Node) => {
    const children = node.getChildren(sf)
    if (children.length) { children.forEach(visit); return }
    if (node.kind !== ts.SyntaxKind.EndOfFileToken) mark(code, node.getStart(sf), node.getEnd())
    addComments(ts.getLeadingCommentRanges(text, node.getFullStart()))
    addComments(ts.getTrailingCommentRanges(text, node.getEnd()))
  }
  visit(sf)
  const commentOnly = new Set([...comments].filter(line => !code.has(line)))
  return { code, commentOnly }
}

function analyse(path: string, text: string, isTest: boolean): FileFacts {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const { code, commentOnly } = lineKinds(sf)
  const sourceLines = text.split("\n")
  const facts: FileFacts = {
    sloc: code.size, commentLines: commentOnly.size,
    lines: [...code].sort((a, b) => a - b).map(line => (sourceLines[line] ?? "").trim().replace(/\s+/g, " ")).filter(line => line.length > 3),
    functions: [], any: 0, tsIgnore: (text.match(/@ts-(?:ignore|nocheck|expect-error)/g) ?? []).length,
    consoleCalls: 0, emptyCatch: 0, todo: (text.match(/\b(?:TODO|FIXME|XXX|HACK)\b/g) ?? []).length, tests: 0, assertions: 0,
  }

  /** Cyclomatic complexity of one function body, without descending into the functions nested in it. */
  const complexity = (body: import("typescript").Node): number => {
    let cc = 1
    const walk = (node: import("typescript").Node) => {
      if (node !== body && FUNCTION_KINDS.has(node.kind)) return
      switch (node.kind) {
        case ts.SyntaxKind.IfStatement: case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement: case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.CatchClause: case ts.SyntaxKind.ConditionalExpression: case ts.SyntaxKind.CaseClause:
          cc++; break
        case ts.SyntaxKind.BinaryExpression: {
          const op = (node as import("typescript").BinaryExpression).operatorToken.kind
          if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) cc++
          break
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(body)
    return cc
  }

  const visit = (node: import("typescript").Node) => {
    if (FUNCTION_KINDS.has(node.kind)) {
      const fn = node as import("typescript").FunctionLikeDeclaration
      if (fn.body) {
        const start = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line
        const end = sf.getLineAndCharacterOfPosition(fn.getEnd()).line
        facts.functions.push({ lines: end - start + 1, cc: complexity(fn.body) })
      }
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) facts.any++
    if (node.kind === ts.SyntaxKind.CatchClause) {
      const block = (node as import("typescript").CatchClause).block
      if (block.statements.length === 0) facts.emptyCatch++
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console") facts.consoleCalls++
      if (ts.isIdentifier(callee) && isTest) {
        if (callee.text === "test" || callee.text === "it") facts.tests++
        if (callee.text === "expect") facts.assertions++
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return facts
}

/** Errors under `strict` in `files`, with Bun's types from this repository for every agent alike. */
function strictErrors(files: string[]): number {
  if (!files.length) return 0
  const program = ts.createProgram(files, {
    noEmit: true, strict: true, skipLibCheck: true, allowJs: false, esModuleInterop: true, resolveJsonModule: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, types: ["bun"], typeRoots: [join(ROOT, "node_modules/@types")],
  })
  const own = new Set(files)
  return ts.getPreEmitDiagnostics(program).filter(d => d.file && own.has(d.file.fileName)).length
}

/** 5-line blocks of normalised code that occur more than once, as a share of all the blocks. */
function duplication(all: string[][]): number {
  const SHINGLE = 5
  const counts = new Map<string, number>()
  let total = 0
  for (const lines of all) {
    for (let i = 0; i + SHINGLE <= lines.length; i++) {
      const key = lines.slice(i, i + SHINGLE).join("\n")
      counts.set(key, (counts.get(key) ?? 0) + 1)
      total++
    }
  }
  if (!total) return 0
  let repeated = 0
  for (const n of counts.values()) if (n > 1) repeated += n
  return repeated / total
}

/** The project's code files as relative paths: what git tracks or would track, without installed packages. */
export function listProjectFiles(projectDir: string, gitFiles: string[]): string[] {
  return gitFiles.filter(file => CODE_FILE.test(file) && !IGNORED.test(`/${file}`) && !file.endsWith(".d.ts"))
}

export function measureCodeQuality(projectDir: string, gitFiles: string[]): CodeQuality {
  const files = listProjectFiles(projectDir, gitFiles)
  const src = files.filter(file => !TEST_FILE.test(file))
  const tests = files.filter(file => TEST_FILE.test(file))
  const read = (file: string) => { try { return readFileSync(join(projectDir, file), "utf8") } catch { return "" } }

  const srcFacts = src.map(file => analyse(join(projectDir, file), read(file), false))
  const testFacts = tests.map(file => analyse(join(projectDir, file), read(file), true))
  const fns = srcFacts.flatMap(f => f.functions)
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const round = (n: number, digits = 2) => +n.toFixed(digits)

  const codeLines = sum(srcFacts.map(f => f.sloc)) + sum(testFacts.map(f => f.sloc))
  const commentLines = sum(srcFacts.map(f => f.commentLines)) + sum(testFacts.map(f => f.commentLines))

  let deps = 0, devDeps = 0
  try {
    const pkg = JSON.parse(read("package.json") || "{}")
    deps = Object.keys(pkg.dependencies ?? {}).length
    devDeps = Object.keys(pkg.devDependencies ?? {}).length
  } catch { /* an invalid package.json counts as none */ }

  return {
    srcFiles: src.length,
    srcSloc: sum(srcFacts.map(f => f.sloc)),
    maxFileSloc: Math.max(0, ...srcFacts.map(f => f.sloc)),
    testFiles: tests.length,
    testSloc: sum(testFacts.map(f => f.sloc)),
    tests: sum(testFacts.map(f => f.tests)),
    assertions: sum(testFacts.map(f => f.assertions)),
    commentRatio: codeLines + commentLines ? round(commentLines / (codeLines + commentLines)) : 0,
    functions: fns.length,
    funcAvgLines: fns.length ? round(sum(fns.map(f => f.lines)) / fns.length, 1) : 0,
    funcMaxLines: Math.max(0, ...fns.map(f => f.lines)),
    ccAvg: fns.length ? round(sum(fns.map(f => f.cc)) / fns.length) : 0,
    ccMax: Math.max(0, ...fns.map(f => f.cc)),
    ccOver10: fns.filter(f => f.cc > 10).length,
    any: sum(srcFacts.map(f => f.any)),
    tsIgnore: sum(srcFacts.map(f => f.tsIgnore)),
    consoleCalls: sum(srcFacts.map(f => f.consoleCalls)),
    emptyCatch: sum(srcFacts.map(f => f.emptyCatch)),
    todo: sum(srcFacts.map(f => f.todo)),
    dupRatio: round(duplication(srcFacts.map(f => f.lines)), 3),
    strictErrors: strictErrors(src.map(file => join(projectDir, file))),
    testStrictErrors: strictErrors(tests.map(file => join(projectDir, file))),
    deps,
    devDeps,
    hasTsconfig: existsSync(join(projectDir, "tsconfig.json")),
  }
}
