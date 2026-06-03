# HiveCode — Overview del Proyecto

HiveCode es un sistema de codificación multi-agente con TUI (Terminal UI) y arquitectura de enjambre de workers. El agente principal (BEE) coordina hasta 13 coordinadores especializados que trabajan en paralelo sobre tareas de desarrollo.

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
         Bun Workers (13 coordinadores)
                │
          SQLite Blackboard
```

---

## Enjambre de Workers

Ver [workers.md](workers.md) para detalle completo.

**Pipeline de niveles:**
```
Nivel 0: ProductManager  → PRD (siempre primero)
Nivel 1: Architecture    → ADR + plan de fases
Nivel 2: BackendEngineer | FrontendEngineer | MobileEngineer | DataScientist | Security
Nivel 3: QAEngineer | DBA
Nivel 4: Integration | DevOps
Nivel 5: CodeReviewer   → gate final
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

SQLite centralizado en `~/.hivecode/data.db`:

| Tabla | Contenido |
|-------|-----------|
| `providers` | LLM providers configurados |
| `models` | Modelos disponibles por provider |
| `mcp_servers` | Servidores MCP (builtin + usuario) |
| `channels` | Canales de comunicación |
| `skills` | Skills activas (FTS5) |
| `tools_index` | Índice FTS5 de herramientas nativas |
| `mcp_tools` | Índice FTS5 de herramientas MCP |
| `code_playbook` | Preferencias y reglas del developer |
| `code_sessions` | Sesiones de trabajo |
| `code_tasks` | Tareas en ejecución |
| `narrative` | Log narrativo de cada tarea |
| `adrs` | Architecture Decision Records |

---

## Descubrimiento de Capacidades

El agente descubre todo via FTS5:

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
