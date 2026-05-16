# hivecode

**Multi-AI Coding Swarm — Consola-first. Enfocado en código. Multi-proveedor.**

`hivecode` es una herramienta de ingeniería de software autónoma impulsada por un enjambre de coordinadores IA especializados. Un único **Architecture Coordinator** actúa como orquestador: recibe la tarea, diseña la arquitectura (ADR), y decide qué enjambre de workers ejecutar y en qué orden. Los workers se despachan en paralelo por niveles de dependencia.

> **Versión:** 0.1.0
> **Runtime:** Bun >= 1.3.13
> **Base de datos:** SQLite WAL
> **Licencia:** hivecode-NC-1.0 (no comercial)

---

## Inicio rápido

```bash
# Clonar e instalar
git clone https://github.com/johpaz/hive-code.git hivecode
cd hivecode
bun install

# Arrancar (levanta gateway + TUI Ratatui)
bun run dev
# o bien: hivecode repl

# Primera vez: configurar un provider
/provider add anthropic
# Introduce la API key cuando se solicite
```

---

## Interfaz: TUI Ratatui

La interfaz es un **terminal Rust compilado** (`packages/tui/`) que comunica con el proceso Bun vía Unix socket IPC. No hay interfaz web ni browser.

```
╭──────────────────────────────────────────────╮
│  hivecode  ·  plan  │  approval  │  auto      │
├──────────────────────────────────────────────┤
│                                              │
│  Tarea: implementa autenticación JWT         │
│                                              │
│  ⬢ Architecture    ████████████ ✓ 12s        │
│  ⬢ Backend         ███████░░░░░ 65%          │
│  ⬢ Test            pending                  │
│                                              │
╰──────────────────────────────────────────────╯
│ > _                                          │
╰──────────────────────────────────────────────╯
```

Para compilar el TUI:
```bash
cd packages/tui && cargo build --release
```

---

## Modos de operación

| Modo | Qué hace | Comando rápido |
|------|----------|---------------|
| `plan` | Architecture Coordinator diseña el ADR y la lista de fases. **Ningún archivo se modifica.** | `/mode set plan` |
| `approval` | Checkpoint interactivo entre cada nivel de fases. Muestra archivos a crear/modificar y pide confirmación. | `/mode set approval` |
| `auto` | Ejecución completa sin intervención. | `/mode set auto` |

Cambia de modo desde el TUI con `/mode set <plan|approval|auto>`.

---

## Arquitectura del enjambre

### BEE — El Senior Dev orquestador

**BEE** es el único punto de entrada para todas las solicitudes. Cada mensaje del usuario pasa primero por BEE, que:

1. Lee el contexto del proyecto (archivos, lenguaje, estructura del repo).
2. Clasifica la intención del usuario.
3. Decide el camino óptimo en base a 4 acciones posibles:

| Acción BEE | Cuándo | Ejemplo |
|------------|--------|---------|
| `respond` | Saludo, pregunta, explicación — sin trabajo técnico | "hola", "qué hace este proyecto?" |
| `fix` | Bug simple en ≤ 3 archivos, sin diseño arquitectónico | "el login falla con email en mayúsculas" |
| `dispatch` | Feature puntual donde el coordinador es obvio | "agrega un test para el módulo auth" |
| `architecture` | Implementación multi-módulo, nuevas entidades, ADR necesario | "implementa notificaciones en tiempo real" |

### Flujo completo

```
Usuario escribe cualquier mensaje
        │
        ▼
  ┌─────────────────────────────────────────────────────┐
  │  BEE — Senior Dev  (siempre primero)                │
  │  Lee archivos, entiende el proyecto, clasifica      │
  └─────────────────────────────────────────────────────┘
        │
  ┌─────┴──────────────────────────────────────────┐
  │                                                │
  ▼                                                ▼
"respond" / "fix"                          "dispatch" / "architecture"
  │                                                │
  ▼                                                ▼
BEE responde o aplica             "dispatch" → coordinadores directos
el fix directamente               "architecture" → Architecture Coordinator
                                         │
                                         ▼
                                  ADR + plan de fases
                                         │
                              CoordinatorManager agrupa por nivel
                                         │
                        ┌────────────────┴───────────────────┐
                        │ Nivel 1 (paralelo)  │ Nivel 2 ...  │
                        │ backend + frontend  │ test + devops │
                        └────────────────────────────────────┘
                                         │
                              En modo approval → checkpoint
```

### Agentes del sistema

| Agente | Rol | Herramientas |
|--------|-----|-------------|
| **BEE** | Senior Dev / orquestador — punto de entrada único | Read + Write (puede arreglar bugs directamente) |
| **architecture** | Diseña ADR, define fases y contratos TypeScript | Solo lectura + write_decision |
| **backend** | APIs, lógica de negocio, DB | Read + Write completo |
| **frontend** | UI, React, CSS | Read + Write completo |
| **security** | Auditoría: credenciales, inputs, permisos | Solo lectura |
| **test** | Tests unitarios, e2e, cobertura | Read + Write + test runner |
| **devops** | Docker, CI/CD, scripts de deploy | Read + Write + shell |

Cada coordinador puede delegar sub-tareas a sus **sub-agentes** vía la tool `spawn_subagent`. Los sub-agentes corren en workers separados (solo generación de texto, sin herramientas de escritura).

---

## Comandos CLI externos

```bash
hivecode repl                          # Iniciar TUI interactivo
hivecode start [--daemon]              # Iniciar gateway en background
hivecode stop                          # Detener gateway
hivecode status                        # Estado del sistema
hivecode doctor                        # Diagnóstico completo
hivecode doctor --fix                  # Correcciones automáticas

hivecode agent list                    # Listar agentes
hivecode agent inspect <name>          # Ver detalles de un agente
hivecode agent edit <name>             # Editar system prompt
hivecode agent reset <name>            # Restaurar system prompt por defecto

hivecode provider list                 # Listar providers configurados
hivecode provider add <name>           # Añadir provider
hivecode provider test <name>          # Ping con latencia

hivecode telegram connect              # Conectar bot de Telegram
```

---

## Comandos internos del TUI (slash commands)

Desde el prompt del TUI escribe `/` para ver las opciones:

```
/provider list|add|set|test|status    Configurar providers de IA
/modelo   list|set|info               Seleccionar modelo
/mode     get|set|history             Cambiar modo Plan/Approval/Auto
/mcp      list|add|enable|disable|test  Integrar servidores MCP
/skill    list|enable|disable|info|add  Cargar y activar skills
/task     list|status|cancel|rollback   Gestionar tareas
/narrative show|search|export         Buscar en el historial
/doctor                               Diagnóstico del sistema
/version                              Versión actual
/help [comando]                       Ayuda detallada
```

---

## Configuración de providers

Las API keys **se almacenan cifradas en SQLite** (tabla `providers`, campo `api_key_encrypted` = base64 de la clave). No se usan variables de entorno ni archivos `.env`.

```
# Dentro del TUI:
/provider add anthropic
/provider add openai
/provider add gemini
/provider set anthropic        # activar como provider por defecto
/modelo set anthropic claude-sonnet-4-6
```

El gateway lee las claves de la BD y las pasa a cada coordinador worker en el campo `task.secrets` al despachar cada fase.

---

## Estructura del monorepo

```
packages/
├── cli/       CLI: comandos externos, REPL, adapters de instalación
├── code/      Motor: CoordinatorManager, workers, seed de código
├── core/      Gateway HTTP/WS, SQLite, agent loop, tools base
├── tui/       TUI Ratatui (Rust) — interfaz de terminal
├── ui/        Componentes de UI para wizards en CLI (@clack)
├── mcp/       Cliente Model Context Protocol
└── skills/    38 skills empaquetadas
```

### Base de datos (SQLite WAL)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA cache_size   = -64000;     -- 64 MB
PRAGMA mmap_size    = 268435456;  -- 256 MB
PRAGMA foreign_keys = ON;
```

Tablas relevantes para el motor de código:

| Tabla | Contenido |
|-------|-----------|
| `providers` | Providers de IA + api_key_encrypted |
| `agents` | Coordinadores y sub-agentes con system_prompt |
| `code_sessions` | Sesiones de trabajo |
| `code_tasks` | Tareas con modo, status, projectPath |
| `code_task_phases` | Fases de cada tarea (por coordinador) |
| `code_narrative` | Historial narrativo estructurado |
| `code_decisions` | ADRs generados por Architecture |
| `code_file_snapshots` | Snapshots de archivos para rollback |
| `code_traces` | Trazas de ejecución de tools |

---

## Build y distribución

```bash
bun run build          # Bundle + workers
bun run build:binary   # Binario standalone
bun run lint           # Type check
bun test               # Tests
bun test --coverage    # Con cobertura
```

Artefactos del build:
```
dist/
├── hivecode.js                # Entry point
├── architecture.worker.js     # Worker coordinador
├── backend.worker.js
├── frontend.worker.js
├── security.worker.js
├── test.worker.js
├── devops.worker.js
└── subagent.worker.js         # Worker sub-agentes
```

---

## Requisitos

- [Bun](https://bun.sh) >= 1.3.13
- [Rust](https://rustup.rs) (solo para compilar el TUI)
- Git

---

## Autor

**Johpaz** — [@johpaz](https://github.com/johpaz)

Hecho en Colombia con Bun y cafe.

---

## Licencia

**hivecode-NC-1.0** — Uso personal y educativo libre. Prohibido uso comercial sin autorización del autor.
Ver [`LICENSE`](./LICENSE) para los términos completos.
