# Code Context Retrieval — FTS5

Sistema de indexación y búsqueda full-text sobre el código fuente del proyecto. Permite a los agentes recuperar contexto relevante del codebase en < 50 ms sin dependencias externas.

## ¿Por qué existe?

El `Context Compiler` inyecta en cada worker un system prompt + skills + playbook + memoria, pero **no incluye el código fuente del propio proyecto**. Antes de este sistema, si un agente necesitaba saber "¿cómo se usa `X` función?" o "¿dónde está definida `Y` clase?", no tenía una forma eficiente de averiguarlo.

| Problema | Sin retrieval | Con retrieval |
|----------|--------------|---------------|
| Worker necesita entender un módulo existente | Lee archivos enteros al azar | Busca por función/clase y recibe el archivo + dependencias |
| Dos workers modifican el mismo archivo | Colisión silenciosa | El indexer rastrea quién importa qué (`exported_by`) |
| Sesión nueva, contexto en cero | Cada tarea empieza de cero | El índice persiste en SQLite entre sesiones |
| Búsqueda por keyword en código | `grep` lento sobre miles de archivos | FTS5 nativo de SQLite con ranking BM25 |

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│  Agente LLM                                                     │
│  └── search_knowledge(type="code", query="functionName")       │
│       └── bm25(code_fts) → file_path + snippet + rank          │
├─────────────────────────────────────────────────────────────────┤
│  Context Retriever                                              │
│  ├── searchCode(sessionId, query) → resultados FTS5            │
│  └── getModuleContext(filePath) → contenido + deps + metadatos │
├─────────────────────────────────────────────────────────────────┤
│  SQLite — Tablas                                                │
│  ├── code_graph    (dependencias, exports, funciones, clases)  │
│  └── code_fts      (virtual FTS5 — contenido full-text)        │
├─────────────────────────────────────────────────────────────────┤
│  Code Indexer                                                   │
│  ├── buildFullIndex()     — indexado completo al iniciar       │
│  ├── updateFileIndex()    — re-indexa un archivo tras edit     │
│  └── reconcileCodeIndex() — detecta stale/deleted periódicamente│
└─────────────────────────────────────────────────────────────────┘
```

---

## Tablas SQLite

### `code_graph` — grafo de dependencias

Tabla normal (no FTS). Guarda metadatos estructurales por archivo:

| Columna | Tipo | Uso |
|---------|------|-----|
| `session_id` | TEXT | Workspace/sesión a la que pertenece |
| `file_path` | TEXT | Path absoluto del archivo |
| `imports` | JSON | Array de paths que este archivo importa |
| `exported_by` | JSON | Array de paths que importan este archivo (reverse map) |
| `exports` | JSON | Nombres de símbolos exportados |
| `functions` | JSON | Nombres de funciones detectadas |
| `classes` | JSON | Nombres de clases detectadas |
| `complexity` | INTEGER | Estimación de complejidad ciclomática |
| `last_modified` | ISO8601 | `mtime` del filesystem al momento del indexado |

### `code_fts` — índice full-text (virtual table)

Tabla virtual FTS5 con tokenizador `porter`. Se sincroniza manualmente con `code_graph`.

| Columna | Indexada | Contenido |
|---------|----------|-----------|
| `session_id` | No (UNINDEXED) | Clave de sesión para filtrar |
| `file_path` | No (UNINDEXED) | Identificador del archivo |
| `content` | Sí | Código fuente completo del archivo |
| `exports` | Sí | Símbolos exportados como texto plano |
| `functions` | Sí | Nombres de funciones como texto plano |
| `classes` | Sí | Nombres de clases como texto plano |

**Por qué standalone:** FTS5 con `content=` + `content_rowid` rompe la sincronía cuando `code_graph` hace `REPLACE` (cambia el `rowid`). Por eso `code_fts` es tabla independiente y se sincroniza con `DELETE + INSERT` explícito.

---

## Ciclo de vida del índice

### 1. Full index — al iniciar proyecto

```typescript
import { buildFullIndex } from "@johpaz/hivecode-code/agent/code-indexer"

const { indexed, skipped, durationMs } = await buildFullIndex(sessionId, workspace)
// → { indexed: 247, skipped: 0, durationMs: 124 }
```

- Escanea `**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`
- Salta `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `target`
- Analiza AST con `Bun.Transpiler` (sin invocar `tsc`)
- Extrae imports, exports, funciones, clases y complejidad
- Inserta en `code_graph` y `code_fts` en transacciones por batch de 50
- Al finalizar: construye `exported_by` (reverse dependency map)

### 2. Incremental — tras cada edición

Cuando un agente ejecuta `fs_edit` o `fs_write`:

```typescript
import { updateFileIndex } from "@johpaz/hivecode-code/agent/code-indexer"

await updateFileIndex(sessionId, filePath, workspace)
```

- Re-analiza el archivo modificado
- `DELETE FROM code_fts WHERE file_path = ?`
- `INSERT INTO code_fts ...`
- Reconstruye `exported_by` para toda la sesión

### 3. Reconciliación — periódica o manual

```typescript
import { reconcileCodeIndex } from "@johpaz/hivecode-code/agent/code-indexer"

const { reindexed, removed, durationMs } = await reconcileCodeIndex(sessionId, workspace)
```

Detecta tres situaciones:

| Situación | Detección | Acción |
|-----------|-----------|--------|
| Archivo modificado externamente | `mtime` del filesystem > `last_modified` en DB + 1s de tolerancia | Re-indexa contenido + metadatos |
| Archivo borrado | Path en DB pero no existe en disco | Elimina de `code_graph` y `code_fts` |
| Archivo nuevo | Path en disco pero no en DB | Indexa por primera vez |

**Recomendación:** llamar `reconcileCodeIndex` al arrancar el REPL/TUI y cada 5 minutos en sesiones largas.

---

## Uso para agentes

### Obtener contexto global — `get_project_context()`

Antes de explorar, los agentes llaman `get_project_context()` para obtener el resumen global del proyecto:
- Estructura de paquetes/directorios
- Archivos clave (package.json, README, tsconfig)
- Módulos más críticos (más importados)
- Decisiones de arquitectura activas (ADRs)

Esta tool está en el `MINIMAL_TOOLSET` — todos los workers la tienen desde el primer turno.

### Búsqueda por keyword — `search_knowledge(type="code")`

Para detalles específicos de implementación (cómo funciona una función interna, qué hace un método, etc.), los agentes usan `search_knowledge` con `type="code"`. Esta tool está disponible para todos los coordinadores.

```typescript
// Dentro de un worker
const result = await search_knowledge({
  type: "code",
  query: " CoordinatorManager dispatchPhase",
  limit: 5,
})

// Resultado:
{
  code: [
    {
      file_path: "/project/packages/code/src/workers/coordinator-manager.ts",
      snippet: "...<match>dispatchPhase</match>(phase: string) {...",
      rank: 0.42,
    }
  ]
}
```

La query soporta:
- Nombres de funciones (`"greet"`)
- Nombres de clases (`"Greeter"`)
- Fragmentos de código (`"export function"`)
- Búsqueda bilingüe español→inglés (fallback automático si hay < 2 resultados)

### Contexto rico de un módulo — `getModuleContext`

Cuando un agente necesita **entender** un archivo (no solo encontrarlo):

```typescript
import { getModuleContext } from "@johpaz/hivecode-code/agent/context-retriever"

const ctx = getModuleContext(sessionId, filePath)
// → {
//   filePath: "/project/packages/code/src/workers/coordinator-manager.ts",
//   content: "... (truncado a 8KB si es muy grande)",
//   contentTruncated: false,
//   imports: ["/project/packages/code/src/workers/types.ts", ...],
//   exportedBy: ["/project/packages/code/src/workers/bee.worker.ts", ...],
//   exports: ["CoordinatorManager", "SessionMode"],
//   functions: ["dispatchPhase", "finalizeTask"],
//   classes: ["CoordinatorManager"],
//   complexity: 47,
// }
```

Esto permite que el agente:
1. Lea el archivo relevante (truncado si es grande)
2. Sepa qué dependencias tiene (para leer contratos)
3. Sepa quién lo importa (para entender impacto de cambios)
4. Vea la complejidad (para decidir si necesita refactorizar)

---

## Integración con el harness

### Context Compiler

El system prompt que recibe cada worker ya incluye:

```
1. Si necesitas una herramienta que no esté en la lista arriba → USA search_knowledge:
   - Herramientas nativas: search_knowledge(type="tools", query="...")
   - Herramientas MCP (externas): search_knowledge(type="mcp", query="...")
   - Código fuente del proyecto: search_knowledge(type="code", query="...")
   - Todo junto: search_knowledge(type="all", query="...")
```

### ConflictDetector

El `exported_by` del `code_graph` permite al `ConflictDetector` saber **quién depende de un archivo** antes de que un worker lo modifique:

```
Worker A intenta editar src/utils/logger.ts
  ├── code_graph.exported_by = ["src/agent/context-compiler.ts", "src/workers/coordinator-manager.ts"]
  ├── Worker B está corriendo y importa logger.ts
  └── ConflictDetector emite severidad "medium" → BEE resuelve antes de permitir la escritura
```

---

## Rendimiento

| Métrica | Valor típico | Notas |
|---------|-------------|-------|
| Full index | ~1-2 segundos | Para 500-1000 archivos TypeScript |
| Incremental | ~5-20 ms | Un solo archivo |
| Búsqueda FTS5 | < 50 ms | Incluso en proyectos grandes |
| Reconciliación | ~100-300 ms | Depende de cuántos archivos cambiaron |
| Storage extra | ~2-3× el tamaño del código | FTS5 indexa contenido + metadatos |

**Optimizaciones aplicadas:**
- Batch writes de 50 archivos por transacción
- WAL mode activo en SQLite (sin bloqueos de lectura)
- `Bun.Transpiler` para AST (sin overhead de `tsc`)
- Índices B-tree en `code_graph(session_id, file_path)`

---

## Archivos clave

| Archivo | Rol |
|---------|-----|
| `packages/code/src/narrative/schema.ts` | DDL de `code_graph` y `code_fts` |
| `packages/code/src/agent/code-indexer.ts` | Indexado full, incremental y reconciliación |
| `packages/code/src/agent/context-retriever.ts` | `searchCode()` y `getModuleContext()` |
| `packages/core/src/tools/core/index.ts` | `search_knowledge` con `type="code"` |
| `packages/core/src/agent/context-compiler.ts` | Inyección de la instrucción en system prompt |

---

## Extensión

### Agregar un nuevo campo indexable

1. Agregar columna a `code_fts` en `schema.ts`:
   ```sql
   CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
     session_id UNINDEXED,
     file_path UNINDEXED,
     content,
     exports,
     functions,
     classes,
     interfaces,  -- nuevo
     tokenize='porter'
   );
   ```

2. Extraer el nuevo campo en `indexFile()` en `code-indexer.ts`:
   ```typescript
   const interfaces = [...source.matchAll(/(?:export\s+)?interface\s+(\w+)/g)]
     .map(m => m[1])
   ```

3. Incluirlo en el `INSERT` de `upsertFileIndex()`:
   ```sql
   INSERT INTO code_fts (..., interfaces) VALUES (..., ?)
   ```

4. Reconstruir el índice:
   ```bash
   hivecode init --reindex
   ```

### Cambiar tokenizador

El tokenizador `porter` hace stemming en inglés. Para proyectos con muchos identificadores en español, evaluar `unicode61` (sin stemming) o un tokenizer custom:

```sql
CREATE VIRTUAL TABLE code_fts USING fts5(
  ..., tokenize='unicode61'
);
```

**Nota:** cambiar el tokenizador requiere reconstruir la tabla virtual completa (no hay ALTER).
