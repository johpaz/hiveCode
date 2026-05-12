# 🐝 Hive-Code

**Multi-AI Coding Swarm** — Consola-first. Enfocado en código. Multi-proveedor.

Hive-Code es una extensión de [Hive](https://github.com/johpaz/hive) que convierte el gateway de agentes en un asistente de ingeniería de software autónomo. Diseña arquitectura, escribe código, ejecuta tests y crea PRs — todo coordinado por 6 especialistas que trabajan en paralelo.

> **Versión:** 0.1.0  
> **Runtime:** Bun >= 1.3.13  
> **Base de datos:** SQLite WAL  
> **Licencia:** MIT

---

## ✨ Características

| Feature | Descripción |
|---------|-------------|
| 🐝 **6 Coordinadores** | Architecture, Backend, Frontend, Security, Test, Devops — cada uno con system prompt especializado |
| ⬡ **Modos de Operación** | `plan` (solo diseña), `approval` (checkpoint interactivo), `auto` (ejecución completa) |
| 📝 **Narrativo** | Historial estructurado de cada tarea: decisiones (ADRs), snapshots de archivos, trazas |
| 🔄 **Fases Paralelas** | Los coordinadores se ejecutan por niveles de dependencia usando `Promise.all` |
| 💾 **SQLite WAL** | 6 pragmas de performance: WAL, mmap 256MB, cache 64MB, foreign keys |
| 🔒 **Seguridad** | API keys vía `Bun.secrets`, nunca en `.env`, logs ni SQLite |
| 🌱 **Seed Automático** | Tools, skills, providers y reglas de playbook se recrean en cada inicio |
| 📦 **Bundle** | Distribución como binario standalone o `npm install -g @johpaz/hive-code` |
| 🧪 **Tests** | `bun test` con cobertura nativa |

---

## 🚀 Instalación

### Requisitos

- [Bun](https://bun.sh) >= 1.3.13
- Git

### Opción 1: Desde npm (próximamente)

```bash
npm install -g @johpaz/hive-code
hive-code init
hive-code run "implementa autenticación JWT"
```

### Opción 2: Desde fuente

```bash
git clone https://github.com/johpaz/hive-code.git
cd hive-code
bun install
bun run build
```

El build genera:
- `dist/hive-code.js` — bundle principal (3.96 MB)
- `dist/*.worker.js` — 6 workers de coordinadores (1.69 MB c/u)
- `dist/hive-code` — wrapper de shell

---

## 🎮 Uso Rápido

```bash
# Modo desarrollo (con gateway y UI web)
bun run dev

# Diseñar sin tocar código
hive-code plan "añadir sistema de notificaciones"

# Ejecutar completo
hive-code run "crear API REST con Bun y Elysia"

# Modo interactivo (checkpoint por fase)
hive-code run "refactorizar módulo de auth" --approval

# Diagnóstico
hive-code doctor
hive-code doctor --fix
```

---

## 🎛️ Modos de Operación

| Modo | Descripción | Uso |
|------|-------------|-----|
| `plan` | El Architecture Coordinator diseña el ADR y las fases. Ninguna tool de escritura se ejecuta. | `hive-code plan "..."` |
| `approval` | Checkpoint entre fases. Muestra qué archivos se crearán/modificarán y pide aprobación. | `hive-code run "..." --approval` |
| `auto` | Ejecución completa sin intervención. | `hive-code run "..."` |

Cambia de modo en cualquier momento con **Shift+Tab**.

---

## 🏗️ Arquitectura

### Monorepo

```
packages/
├── core/          # Gateway HTTP, SQLite, agent loop, tools
├── cli/           # Comandos CLI con @clack/core
├── code/          # Coordinadores, workers, seed de código
├── skills/        # 38 skills empaquetadas (bundle generado)
├── mcp/           # Cliente MCP (Model Context Protocol)
└── tts/           # Servidor TTS local
```

### Coordinadores (6 Workers)

Cada coordinador corre en un hilo dedicado (`Bun.Worker`) con auto-restart:

| Coordinador | Rol | Sub-agentes |
|-------------|-----|-------------|
| **architecture** | Diseña ADR, define fases, contratos TypeScript | diagram-agent, interface-agent, dependency-analyzer |
| **backend** | Implementa TypeScript para Bun | api-agent, db-agent, integration-agent |
| **frontend** | UI, React, CSS | component-agent, state-agent, test-agent |
| **security** | Audita credenciales, inputs, permisos | audit-agent, crypto-agent |
| **test** | Tests unitarios, e2e, coverage | test-gen-agent, mock-agent |
| **devops** | Docker, CI/CD, scripts | deploy-agent, config-agent |

### Flujo de Ejecución

```
1. CLI recibe comando → inicializa DB + schemas + seeds
2. Architecture Coordinator genera ADR + fases
3. Fases se agrupan por nivel de dependencia (topological sort)
4. Cada nivel ejecuta en paralelo (Promise.all)
5. En modo approval: checkpoint entre niveles
6. Al finalizar: git commit + opcional PR
```

---

## 🗄️ Base de Datos

SQLite con WAL (Write-Ahead Logging):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;      -- 64 MB
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;    -- 256 MB
PRAGMA foreign_keys = ON;
```

### Tablas `code_*`

- `code_sessions` — sesiones de proyecto
- `code_tasks` — tareas de código
- `code_task_phases` — fases de cada tarea
- `code_narrative` — historial narrativo
- `code_decisions` — ADRs (Architecture Decision Records)
- `code_file_snapshots` — snapshots de archivos para rollback
- `code_traces` — trazas de ejecución de tools
- `code_playbook` — reglas aprendidas del ACE Reflector

---

## 🌱 Seed Automático

En cada inicio del servicio se ejecuta automáticamente:

1. **Core seed** (`packages/core/src/storage/seed.ts`)
   - 77 tools generales
   - 38 skills
   - 14 providers LLM
   - 97 models
   - 2 canales (incl. webchat)
   - 8 reglas ACE playbook

2. **Code seed** (`packages/code/src/seed.ts`)
   - 16 tools de código (`fs_read`, `git_status`, `code_test`, etc.)
   - Skills de código desde el bundle (`test_driven_development`, `code_security_audit`, `git_workflow`)
   - 8 reglas de playbook específicas de código

Los datos se insertan con `INSERT OR REPLACE` — preserva cambios del usuario mientras actualiza lo que cambió en el código.

---

## 🛠️ Comandos CLI

```bash
# Tareas de código
hive-code plan "<descripción>"          # Modo plan
hive-code run "<descripción>"            # Modo auto
hive-code run "<descripción>" --approval # Modo approval
hive-code task rollback <id>             # Revertir tarea
hive-code task resume <id>               # Reanudar tarea pausada

# Providers
hive-code provider list                  # Listar providers
hive-code provider add <name>            # Añadir provider
hive-code provider test <name>           # Ping con latencia

# MCP Servers
hive-code mcp list                       # Listar MCPs
hive-code mcp add <url>                  # Añadir MCP
hive-code mcp test <name>                # Verificar conexión

# Skills
hive-code skill list                     # Listar skills
hive-code skill enable <name>            # Habilitar skill
hive-code skill assign <skill> <coord>   # Asignar a coordinador

# Agentes
hive-code agent list                     # Listar agentes
hive-code agent inspect <name>           # Ver detalles
hive-code agent edit <name>              # Editar system prompt

# Narrativo
hive-code narrative show                 # Mostrar narrativo
hive-code narrative search <query>       # Buscar en narrativo
hive-code narrative export               # Exportar a Markdown

# Sistema
hive-code doctor                         # Diagnóstico completo
hive-code doctor --fix                   # Correcciones automáticas
hive-code mode history                   # Historial de modos
hive-code upgrade                        # Verificar actualizaciones
hive-code init [path]                    # Inicializar proyecto

# Gateway
hive-code start                          # Iniciar gateway
hive-code dev                            # Modo desarrollo
hive-code stop                           # Detener gateway
hive-code status                         # Estado del sistema
```

---

## 📦 Build

```bash
# Bundle + workers + wrappers de shell
bun run build

# Binario standalone
bun run build:binary

# Type check
bun run lint

# Tests
bun test
```

### Salida del build

```
dist/
├── hive-code.js              # 3.96 MB — entry point
├── architecture.worker.js    # 1.69 MB
├── backend.worker.js         # 1.68 MB
├── frontend.worker.js        # 1.68 MB
├── security.worker.js        # 1.68 MB
├── test.worker.js            # 1.68 MB
├── devops.worker.js          # 1.68 MB
├── hive-code                 # Wrapper Unix
├── hive-code.cmd             # Wrapper Windows
└── hive-code.ps1             # Wrapper PowerShell
```

---

## 🔧 Configuración

```bash
# API keys (almacenadas en Bun.secrets, nunca en disco)
hive-code secret set ANTHROPIC_API_KEY
hive-code secret set OPENAI_API_KEY

# Modo por defecto
hive-code mode set auto

# Directorio de datos
export HIVE_HOME=$HOME/.hive
```

---

## 🧪 Tests

```bash
bun test              # Ejecutar tests
bun test --coverage   # Con cobertura
```

> **Nota:** Aún no hay tests de integración. Están en el roadmap.

---

## 📚 Documentación

- [`SPEC.md`](./SPEC.md) — Especificación completa del protocolo
- [`AUDITORIA_FALTA_SOBRA.md`](./AUDITORIA_FALTA_SOBRA.md) — Estado de implementación y pendientes
- [`GAP_ANALYSIS.md`](./GAP_ANALYSIS.md) — Análisis de cobertura

---

## 🤝 Contribuir

1. Fork el repo
2. Crea una rama: `git checkout -b feature/nueva-feature`
3. Commitea: `git commit -m "feat: nueva feature"`
4. Push: `git push origin feature/nueva-feature`
5. Abre un PR

---

## 👤 Autor

**Johpaz** — [@johpaz](https://github.com/johpaz)

🇨🇴 Hecho en Colombia con Bun y café.

---

## 📄 Licencia

MIT © Johpaz
