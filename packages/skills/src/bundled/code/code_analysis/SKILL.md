---
name: code_analysis
description: "Deep code analysis: AST parsing, type checking, dependency graph, diffs, and script execution"
version: 1.0.0
author: Hive Team
icon: "🔬"
category: code
permissions:
  - filesystem_read
  - shell_exec
dependencies: []
tools: [parse_ast, find_imports, check_types, code_diff_create, code_test_parallel, run_script]

triggers:
  - "analizá el código"
  - "analyze code"
  - "qué importa este archivo"
  - "who imports this"
  - "verificá tipos"
  - "check types"
  - "typecheck"
  - "tsc"
  - "errores de typescript"
  - "typescript errors"
  - "diff entre archivos"
  - "diff between files"
  - "ejecutá este script"
  - "run this script"
  - "tests en paralelo"
  - "parallel tests"
  - "dependencias inversas"
  - "reverse dependencies"
  - "AST"
  - "árbol sintáctico"
  - "complejidad ciclomática"
  - "cyclomatic complexity"

preferred_agents: []

steps:
  - step: 1
    action: choose_tool
    instruction: "Select the appropriate analysis tool based on what's needed"
    output: tool_selected

  - step: 2
    action: execute_analysis
    instruction: "Run the selected tool and interpret results"
    output: analysis_result

rules:
  - "Use parse_ast BEFORE fs_read on large files — it gives structure without reading everything"
  - "Use find_imports to understand impact before modifying a module"
  - "Run check_types after edits to catch TypeScript errors early"
  - "Use code_test_parallel when running multiple test suites — faster than sequential"
  - "run_script is for utility scripts, migrations, seeders — has 60s timeout"
  - "code_diff_create for code review — shows exactly what changed between two versions"

output_format:
  structure: analysis_report
  max_length: "Concise findings with relevant snippets"

examples:
  - user_input: "qué archivos importan auth/jwt.ts"
    expected_behavior: "find_imports({ path: 'auth/jwt.ts' }) → lista de archivos importadores"

  - user_input: "verificá tipos del proyecto"
    expected_behavior: "check_types({ path: '.' }) → errores de TypeScript con líneas"

  - user_input: "analizá la estructura de este archivo antes de editarlo"
    expected_behavior: "parse_ast({ path: 'src/service.ts' }) → funciones, clases, imports, complejidad"
---

# Code Analysis Skill

## Cuándo se Activa

Para entender profundamente la estructura del código antes de modificarlo, verificar tipos, analizar dependencias o ejecutar scripts de utilidad.

## Herramientas Disponibles

| Tool | Qué hace | Cuándo usarla |
|------|----------|---------------|
| `parse_ast` | AST: funciones, clases, imports, complejidad | Antes de editar archivos grandes |
| `find_imports` | ¿Quién importa este módulo? (grafo inverso) | Antes de renombrar/mover módulos |
| `check_types` | TypeScript type-check completo (`bun tsc --noEmit`) | Después de editar, antes de commit |
| `code_diff_create` | Diff unificado entre dos archivos o versiones | Code review, documentar cambios |
| `code_test_parallel` | Ejecutar múltiples suites de tests concurrentemente | Proyectos con muchos test suites |
| `run_script` | Ejecutar archivo TS/JS en subproceso aislado (60s) | Scripts de utilidad, migrations, seeders |

## Flujo de Análisis Previa a Edición

```
1. parse_ast(path)           → entender estructura
2. find_imports(path)        → evaluar impacto del cambio
3. [hacer ediciones]
4. check_types()             → verificar no rompí nada
5. code_diff_create(a, b)    → documentar qué cambió
```

## Ejemplos

### Analizar AST
```javascript
parse_ast({ path: "src/coordinator/manager.ts" })
// → { imports: [...], exports: [...], functions: [{name, lines, complexity}], classes: [...] }
```

### Encontrar dependientes
```javascript
find_imports({ path: "packages/core/src/storage/sqlite.ts" })
// → { importers: ["src/tools/...", "src/gateway/..."], count: 12 }
```

### Verificar tipos
```javascript
check_types({ path: "packages/core" })
// → { pass: false, errors: [{message: "Type 'string' is not assignable..."}], duration: 8.2s }
```

### Tests en paralelo
```javascript
code_test_parallel({
  suites: [
    { label: "Unit", pattern: "tests/unit/**" },
    { label: "Integration", pattern: "tests/integration/**" },
    { label: "E2E", pattern: "tests/e2e/**" }
  ]
})
// → { pass: true, total: 84, suites: [{label, ok, pass, fail, durationMs}] }
```

### Ejecutar script de utilidad
```javascript
run_script({ path: "scripts/migrate-db.ts" })
// → resultado de ejecución del script en subproceso aislado
```

## Mejores Prácticas

- **parse_ast primero** para archivos > 200 líneas antes de fs_read
- **find_imports** antes de mover o eliminar un módulo
- **check_types** es la verificación más importante post-edición
- **run_script** tiene timeout de 60s — no para scripts largos
- **code_test_parallel** ahorra tiempo en proyectos con múltiples suites
