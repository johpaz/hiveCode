# HiveCode — Overview del Proyecto

HiveCode es un sistema de codificación multi-agente con TUI (Terminal UI) y arquitectura de enjambre de workers. El agente principal (BEE) coordina 11 coordinadores especializados (más 2 on-demand) que trabajan en paralelo sobre tareas de desarrollo. El roster está deliberadamente consolidado: cada coordinador cubre una responsabilidad no redundante, evitando "escritores paralelos" que puedan asumir contratos conflictivos entre sí sobre el mismo módulo (ver [workers.md](workers.md) para el razonamiento detrás de cada fusión).

---

## Monorepo

```
packages/
├── cli/         — Punto de entrada en consola (@johpaz/hivecode-cli)
├── code/        — 6 workers coordinadores en Bun Worker (@johpaz/hivecode-code)
├── core/        — Motor multi-agente: tools, gateway, storage (@johpaz/hivecode-core)
├── hivetui/     — Terminal UI en Rust (Ratatui)
├── mcp/         — Cliente Model Context Protocol (@johpaz/hivecode-mcp)
└── skills/      — Sistema de skills bundleadas (@johpaz/hivecode-skills)
```

---

## Arquitectura General

```
Usuario (TUI Rust)
      │  IPC Unix socket
      ▼
tui-launcher.ts (Bun)
      │
      ▼
Gateway (Bun HTTP + WebSocket)
      │
      ├── Agent Loop ──→ LLM Provider (Claude/Gemini/Qwen/OpenAI)
      │                       │
      │                  Tool Calls
      │                       │
      ├── Native Tools (55+)  ├── MCP Tools (dinámicos)
      │
      └── CoordinatorManager
                │
         Bun Workers (11 coordinadores + 2 on-demand)
                │
          HiveDB Blackboard
```

---

## Enjambre de Workers

Ver [workers.md](workers.md) para detalle completo.

**Pipeline de niveles:**
```
Nivel 0: ProductManager  → PRD (siempre primero)
Nivel 1: Architecture    → ADR + plan de fases
Nivel 2: BackendEngineer (absorbe DBA) | FrontendEngineer (absorbe Mobile) | DataScientist | Security (transversal)
Nivel 3: QAEngineer | Security (dedicado)
Nivel 4: DevOps
Nivel 5: Verifier        → reproduce los criterios de aceptación del PRD contra el sistema real
Nivel 6: CodeReviewer    → gate final (absorbe Integration: cruza contratos entre módulos)
```

**On-demand:** `Librarian` (post-sesión) · `ForensicAgent` (recuperación de fallos)

**Modos:**
| Modo | Comportamiento |
|------|---------------|
| `auto` | Ejecuta pipeline completo sin pausas |
| `plan` | Solo muestra ARNÉS, no ejecuta nada |
| `approval` | Pipeline con checkpoint entre niveles |

---

## Canales de Comunicación con el Usuario

| Canal | Estado por defecto |
|-------|-------------------|
| `webchat` | Activo (sin credenciales) |
| `telegram` | Requiere token de bot |

Telegram es el canal principal para notificaciones del agente fuera del TUI.

---

## Storage

HiveDB centralizado en `./hivecode` respecto al directorio desde el que se ejecuta el CLI. `HIVE_DB_PATH` permite definir una ruta explícita:

| Tabla | Contenido |
|-------|-----------|
| `providers` | LLM providers configurados |
| `models` | Modelos disponibles por provider |
| `mcpServers` | Servidores MCP (builtin + usuario) |
| `channels` | Canales de comunicación |
| `skills` | Skills activas (HiveDB index) |
| `tools_index` | Índice HiveDB index de herramientas nativas |
| `mcp_tools` | Índice HiveDB index de herramientas MCP |
| `code_playbook` | Preferencias y reglas del developer |
| `code_sessions` | Sesiones de trabajo |
| `codeTasks` | Tareas en ejecución |
| `narrative` | Log narrativo de cada tarea |
| `adrs` | Architecture Decision Records |

---

## Descubrimiento de Capacidades

El agente descubre todo via HiveDB index:

```
search_knowledge(type="tools",  query="leer archivos grandes")
search_knowledge(type="skills", query="investigar web y guardar")
search_knowledge(type="mcp",    query="github pull request")
search_knowledge(type="playbook", query="convenciones del proyecto")
search_knowledge(type="code",   query="clase Repository")
```

---

## Documentación Adicional

| Documento | Contenido |
|-----------|-----------|
| [tools.md](tools.md) | Referencia de las 55+ herramientas nativas |
| [skills.md](skills.md) | Referencia de los 32 skills bundleados |
| [mcp.md](mcp.md) | Configuración y uso de servidores MCP |
| [workers.md](workers.md) | Arquitectura del enjambre de workers |
| [harness.md](harness.md) | Sistema de checkpoints y recuperación |
| [code-context-retrieval.md](code-context-retrieval.md) | Indexación y recuperación de contexto de código |
