# Hive-Code — Especificación Técnica v1.1
**Spec-Driven Development · Actualizado Mayo 2026**

---

## RESUMEN DE CAMBIOS v1.0 → v1.1

Este documento actualiza la especificación original con tres adiciones concretas:

1. **Mascota ASCII abeja compacta (variante B)** — cambia expresión según estado del sistema
2. **Comandos internos de la app** — `/provider`, `/modelo`, `/mcp`, `/skill`, `/mode`, etc.
3. **Sistema de help integrado** — `help`, `help <comando>`, ejemplos en tiempo real

---

## 1. MASCOTA VISUAL — Abeja Compacta

### Constantes de la mascota

Crear en `packages/cli/src/ui/mascot.ts`:

```typescript
// packages/cli/src/ui/mascot.ts
// Expresiones de la abeja según estados del sistema

export const BEE = {
  // Prompt / bienvenida — abeja feliz, lista para trabajar
  happy:    '\\(^ᴗ^)/',
  
  // Pensando / generando código — ojos entrecerrados
  thinking: ' (~ᴗ~) ',
  
  // Completado exitosamente — ojos estrella
  done:     ' (★ᴗ★)',
  
  // Error / blocker — ojos X, indicador de problema
  error:    ' (×ᴗ×)',
  
  // Idle / esperando — abeja dormida
  idle:     ' (-ᴗ-) ',
  
  // Modo PLAN — ojos abiertos, observando el análisis
  plan:     ' (oᴗo)',
  
  // Esperando aprobación del usuario — punto de decisión
  waiting:  ' (?ᴗ?) ',
  
  // Estado neutral en mensajes
  neutral:  ' (·ᴗ·)',
} as const;

// Versión con cuerpo completo para bienvenida
export const BEE_FULL = `
  \\( ${BEE.happy} )/
  ▐▓▓▓▓▓▌
  ▐▓▓▓▓▓▌
  ╚═══╝
`;

// Color por coordinador para la barra lateral cuando está activo
export const BEE_COORDINATOR = {
  architecture: '⬡',  // hexágono vacío
  backend:      '⬡',
  frontend:     '⬡',
  security:     '⬡',
  test:         '⬡',
  devops:       '⬡',
  principal:    '⬡',
  done:         '⬢',  // hexágono sólido
} as const;
```

### Uso en la UI

El BEE se integra en los componentes existentes de `theme.ts`:

```typescript
// En hiveIntro()
export function hiveIntro(title: string): void {
  process.stdout.write(
    `\n  ${BEE.happy}  ${C.bold}${C.amber}${title}${C.reset}\n` +
    `  ${C.amber}${S.bar}${C.reset}\n`
  );
}

// En hiveSpinner()
export function hiveSpinner(coordinator = 'default') {
  const frames = [BEE.thinking, BEE.plan, BEE.thinking];
  // ... resto del código
}

// En hivePhaseComplete()
export function hivePhaseComplete(coordinator: string, summary: string): void {
  process.stdout.write(
    `  ${BEE.done}  ${C.white}${summary}${C.reset}\n`
  );
}
```

---

## 2. COMANDOS INTERNOS DE LA APP

Los comandos internos son diferentes del CLI. Se escriben **después de que el prompt aparece**, como si fuera una pseudo-shell dentro de Hive-Code. Comienzan con `/`.

### Categorías de comandos internos

#### A. Configuración de Providers

```
/provider list                    — muestra providers configurados + modelo activo
/provider add <name>              — wizard: solicita API key → Bun.secrets
/provider set <name>              — cambia provider activo
/provider test <name>              — ping al provider, mide latencia
/provider status                   — estado de todos los providers

Ejemplos:
  /provider set anthropic
  /provider add openai
  /provider test anthropic
```

#### B. Selección de Modelo

```
/modelo list [provider]            — lista modelos disponibles por provider
/modelo set <provider> <modelo>    — cambia modelo activo
/modelo info <modelo>              — detalles: contexto max, costo, latencia

Ejemplos:
  /modelo set anthropic claude-sonnet-4-6
  /modelo list anthropic
  /modelo info claude-sonnet-4-6
```

#### C. MCP (Model Context Protocol) Servers

```
/mcp list                          — lista MCPs: connected / disconnected
/mcp add <url-or-name>             — registra nuevo MCP
/mcp enable <name>                 — activa MCP en sesión actual
/mcp disable <name>                — desactiva sin eliminar config
/mcp test <name>                   — verifica conexión y lista tools

Ejemplos:
  /mcp add git://github.com/anthropic/mcp-git
  /mcp enable filesystem
  /mcp test github
```

#### D. Skills

```
/skill list                        — lista skills: built-in / custom / active
/skill enable <name>               — activa skill para todos los coordinadores
/skill disable <name>              — desactiva sin eliminar
/skill info <name>                 — muestra contenido y metadata
/skill add <path>                  — importa skill desde archivo .md local

Ejemplos:
  /skill enable security_owasp
  /skill add ~/my-skills/custom_auth.md
  /skill info rest_api_design
```

#### E. Modos de Operación

```
/mode get                          — muestra modo actual
/mode set <plan|approval|auto>     — cambia modo
/mode history                      — historial de cambios de modo

Ejemplos:
  /mode set plan
  /mode set approval
```

#### F. Tareas

```
/task list [--limit 10]            — tareas recientes
/task status <id>                  — estado detallado + fase actual
/task cancel <id>                  — cancela tarea en curso
/task rollback <id>                — revierte cambios de una tarea

Ejemplos:
  /task list
  /task status abc123
  /task rollback abc123
```

#### G. Narrativo y Contexto

```
/narrative show [--last 5]         — muestra últimas N entradas
/narrative search <query>          — busca en el narrativo por FTS5
/narrative export [--format md]    — exporta narrativo completo

Ejemplos:
  /narrative search "JWT authentication"
  /narrative show --last 10
```

#### H. ACE (Adaptive Codex Engine)

```
/ace status                        — estado: trazas pendientes, última reflexión
/ace playbook list                 — reglas aprendidas (activas + inactivas)
/ace playbook reset                — borra playbook y reinicia aprendizaje
/ace reflector run                 — fuerza análisis inmediato

Ejemplos:
  /ace status
  /ace reflector run
```

#### I. GitHub

```
/github status                     — verifica token válido y permisos
/github whoami                     — muestra usuario autenticado
/github set-repo <owner/repo>      — vincula a repo específico

Ejemplos:
  /github set-repo johpaz/mi-app
  /github whoami
```

#### J. Sistema y Diagnóstico

```
/doctor                            — chequeo completo del sistema
/version                           — muestra versión + commit hash
/env                               — muestra variables de entorno no sensibles
/help [<comando>]                  — muestra ayuda

Ejemplos:
  /doctor
  /help provider
  /help /skill add
```

### Estructura de respuesta de comandos internos

Cada comando devuelve una respuesta estructurada con formato consistente:

```
⬡  ejecutando /provider list
│
│  Providers configurados:
│
│  ▸ anthropic        claude-sonnet-4-6  [ACTIVO]
│  · openai           gpt-4-turbo         [inactivo]
│  · groq             mixtral-8x7b        [inactivo]
│
│  Cambiar con: /provider set <nombre>
│
```

---

## 3. SISTEMA DE HELP INTEGRADO

### Help automático en prompts

Cuando el usuario escribe `/help`, se muestra un menú categorizado:

```
\(^ᴗ^)/  ¿Necesitas ayuda?
  ▐▓▌  │
       │  /provider  — configurar providers de IA
       │  /modelo    — seleccionar modelo + contexto
       │  /mcp       — integrar servidores MCP
       │  /skill     — cargar y activar skills
       │  /mode      — cambiar modo Plan/Approval/Auto
       │  /task      — gestionar tareas
       │  /narrative — buscar en el historial
       │  /ace       — aprendizaje adaptativo
       │  /doctor    — diagnóstico completo
       │
       │  Escribe: /help <comando>  para detalles
       │  Ejemplo: /help /provider set
       │
```

### Help específico de comando

Escribir `/help /provider set` muestra:

```
\(^ᴗ^)/  /provider set <nombre>
  ▐▓▌  │
       │  Cambia el provider activo para las llamadas LLM.
       │
       │  SINTAXIS
       │  ────────
       │  /provider set <nombre>
       │
       │  ARGUMENTOS
       │  ──────────
       │  <nombre>   nombre del provider (anthropic, openai, groq, etc.)
       │
       │  EJEMPLOS
       │  ────────
       │  /provider set anthropic
       │  /provider set openai
       │
       │  NOTAS
       │  ─────
       │  · El provider debe estar configurado previamente
       │  · Puedes ver disponibles con: /provider list
       │  · El cambio se aplica inmediatamente
       │  · La sesión actual no se interrumpe
       │
```

### Help en tiempo real con autocompletado

Cuando el usuario empieza a escribir `/pro`, el sistema autocompleta:

```
\(^ᴗ^)/  ¿Qué quieres hacer hoy?
  ▐▓▌  │  /pro
       │
       │  Sugerencias:
       │  ▸ /provider list
       │  · /provider add
       │  · /provider set
       │  · /provider test
       │  · /provider status
       │
       │  /pro[ver|mplete con Tab]
```

Si presiona Tab, autocompleta a `/provider`. Si escribe `/provider ` (con espacio), muestra las opciones disponibles:

```
\(^ᴗ^)/  /provider
  ▐▓▌  │
       │  ▸ list      — muestra providers + modelo activo
       │  · add       — agregar nuevo provider
       │  · set       — cambiar provider activo
       │  · test      — ping al provider
       │  · status    — estado de todos
       │
```

---

## 4. FLUJO COMPLETO DE USO INTERNO

### Ejemplo real: cambiar a OpenAI desde Anthropic

```
\(^ᴗ^)/  hive-code v1.0.0 · @johpaz
  ▐▓▌  │
       │  Modo: PLAN [shift+tab]  Provider: anthropic  Workers: 6 activos
       │
       └─────────────────────────────────────────────────
  \(^ᴗ^)/  ¿Qué quieres construir?
  ▐▓▌  │  /provider list
       │
       │  ▸ anthropic        claude-sonnet-4-6  [ACTIVO]
       │  · openai           (no configurado)
       │  · groq             mixtral-8x7b       [inactivo]
       │
       │  Cambiar con: /provider set <nombre>
       │  Agregar con:  /provider add openai
       │
  \(^ᴗ^)/  /provider add openai
  ▐▓▌  │
       │  🔐 Solicitar API key de OpenAI
       │  (se ingresa de forma segura, no visible en pantalla)
       │
       │  ✓ API key guardada en Bun.secrets
       │
  \(^ᴗ^)/  /provider set openai
  ▐▓▌  │
       │  ⬢ Provider cambiado a openai
       │  ⬢ Modelos disponibles:
       │    - gpt-4-turbo (128k contexto)
       │    - gpt-4 (8k contexto)
       │    - gpt-3.5-turbo (4k contexto)
       │
  \(^ᴗ^)/  /modelo set openai gpt-4-turbo
  ▐▓▌  │
       │  ⬢ Modelo: gpt-4-turbo [OpenAI]
       │  ⬢ Contexto máximo: 128k tokens
       │  ⬢ Listo para usar
       │
  \(^ᴗ^)/  ¿Qué quieres construir?
  ▐▓▌  │  implementa autenticación JWT
```

---

## 5. INTEGRACIÓN EN EL COORDINADOR PRINCIPAL

El Coordinador Principal necesita un parser de comandos internos:

```typescript
// packages/code/src/coordinator/command-parser.ts

export async function parseInternalCommand(
  input: string,
  db: Database,
  ctx: ContextState
): Promise<{ handled: boolean; output?: string; newState?: Partial<ContextState> }> {

  if (!input.startsWith('/')) {
    return { handled: false };  // no es comando interno
  }

  const [cmd, ...args] = input.slice(1).split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'provider':
      return handleProviderCommand(args, db, ctx);
    case 'modelo':
      return handleModelCommand(args, db, ctx);
    case 'mcp':
      return handleMcpCommand(args, db, ctx);
    case 'skill':
      return handleSkillCommand(args, db, ctx);
    case 'mode':
      return handleModeCommand(args, db, ctx);
    case 'task':
      return handleTaskCommand(args, db, ctx);
    case 'narrative':
      return handleNarrativeCommand(args, db, ctx);
    case 'ace':
      return handleAceCommand(args, db, ctx);
    case 'github':
      return handleGithubCommand(args, db, ctx);
    case 'doctor':
      return { output: await runDoctor(db), handled: true };
    case 'help':
      return { output: renderHelp(args[0]), handled: true };
    case 'version':
      return { output: `hive-code v${VERSION}  ${GIT_HASH}`, handled: true };
    default:
      return {
        handled: true,
        output: `comando desconocido: ${cmd}\n\nEscribe /help para ver la lista completa`,
      };
  }
}

async function handleProviderCommand(
  args: string[],
  db: Database,
  ctx: ContextState
): Promise<{ handled: boolean; output: string; newState?: Partial<ContextState> }> {
  const [action, ...rest] = args;

  switch (action) {
    case 'list': {
      const providers = db.query(`SELECT * FROM providers ORDER BY active DESC, name`)
        .all() as Provider[];
      const output = renderProviderList(providers, ctx.activeProvider);
      return { handled: true, output };
    }
    case 'add': {
      const name = rest[0];
      if (!name) return {
        handled: true,
        output: 'uso: /provider add <nombre>\nejemplos: /provider add openai',
      };
      // Solicitar API key de forma segura
      const key = await promptSecureInput(`API key para ${name}: `);
      if (!key) return { handled: true, output: 'cancelado' };
      
      await Bun.secrets.set({ service: 'hive', name: `${name}-key`, value: key });
      db.run(`INSERT OR IGNORE INTO providers (name) VALUES (?)`, [name]);
      return {
        handled: true,
        output: `✓ ${name} agregado\n\nActivar con: /provider set ${name}`,
      };
    }
    case 'set': {
      const name = rest[0];
      if (!name) return {
        handled: true,
        output: 'uso: /provider set <nombre>\ndisponibles: ' +
          db.query(`SELECT name FROM providers`).all()
            .map((p: any) => p.name).join(', '),
      };
      
      db.run(`UPDATE context_state SET active_provider = ? WHERE session_id = ?`,
        [name, ctx.sessionId]);
      return {
        handled: true,
        output: `⬢ Provider: ${name}`,
        newState: { activeProvider: name },
      };
    }
    case 'test': {
      const name = rest[0] ?? ctx.activeProvider;
      const start = performance.now();
      const result = await testProviderConnection(name);
      const latency = performance.now() - start;
      return {
        handled: true,
        output: result.success
          ? `✓ ${name} respondió en ${latency.toFixed(0)}ms`
          : `✗ ${name} no responde: ${result.error}`,
      };
    }
    default:
      return {
        handled: true,
        output: 'opciones: list | add | set | test | status\n\nEscribe /help /provider',
      };
  }
}

// Similar para handleModelCommand, handleMcpCommand, etc.
```

---

## 6. ALMACENAMIENTO DE CONFIGURACIÓN

Agregar a `packages/code/src/storage/schema.ts`:

```sql
-- Configuración de providers
CREATE TABLE IF NOT EXISTS providers (
  name          TEXT PRIMARY KEY,
  display_name  TEXT,
  base_url      TEXT,
  models        TEXT,  -- JSON array
  added_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Estado actual de la sesión
CREATE TABLE IF NOT EXISTS context_state (
  session_id       TEXT PRIMARY KEY REFERENCES sessions(id),
  active_provider  TEXT DEFAULT 'anthropic',
  active_model     TEXT DEFAULT 'claude-sonnet-4-6',
  active_mode      TEXT DEFAULT 'plan',
  active_mcp       TEXT DEFAULT '[]',  -- JSON array
  active_skills    TEXT DEFAULT '[]',  -- JSON array
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Historial de cambios de modo (para análisis del ACE)
CREATE TABLE IF NOT EXISTS session_mode_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  old_mode        TEXT NOT NULL,
  new_mode        TEXT NOT NULL,
  changed_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 7. VALIDACIÓN Y AUTOCOMPLETE

El autocompletado de comandos internos usa FTS5 sobre una tabla `commands_fts`:

```typescript
// En context-compiler para sugerir comandos mientras el usuario escribe

export function suggestCommands(prefix: string): string[] {
  if (!prefix.startsWith('/')) return [];

  const search = prefix.slice(1).toLowerCase();
  if (search.length < 2) return [];

  return db.query(`
    SELECT command FROM commands_fts
    WHERE commands_fts MATCH '${search}*'
    ORDER BY rank
    LIMIT 5
  `).all().map((r: any) => '/' + r.command);
}
```

---

## 8. EJEMPLOS DE FLUJOS COMPLETOS

### Flujo A: Usuario quiere cambiar todo a OpenAI

```
usuario escribe: /provider add openai
↓
Sistema verifica que no exista
↓
Prompt seguro: 🔐 API key para openai:
↓
Usuario ingresa key (no visible)
↓
Sistema guarda en Bun.secrets
↓
Mensaje: ✓ openai agregado

usuario escribe: /modelo list openai
↓
Sistema retorna modelos disponibles de OpenAI

usuario escribe: /provider set openai
↓
Sistema cambia provider activo
↓
Mensaje: ⬢ Provider: openai

usuario escribe: /modelo set openai gpt-4-turbo
↓
Sistema cambia modelo activo
↓
Mensaje: ⬢ Modelo: gpt-4-turbo
```

### Flujo B: Búsqueda en narrativo

```
usuario escribe: /narrative search JWT
↓
FTS5 busca con stemming
↓
Sistema retorna 5 entradas relevantes con snippet y highlight

usuario escribe: /narrative show --last 10
↓
Sistema muestra últimas 10 entradas del narrativo

usuario escribe: /narrative export --format md
↓
Sistema crea un archivo markdown del narrativo completo
```

### Flujo C: Diagnóstico del sistema

```
usuario escribe: /doctor
↓
Sistema verifica:
  - Versión de Bun
  - Providers: ping a cada uno, mide latencia
  - Workers: estado de cada thread
  - MCP: conexión a cada server
  - GitHub: token válido
  - Skills: todas las built-in presentes
  - Espacio en disco
↓
Muestra reporte con ✓ y ✗
```

---

## 9. PRECEDENCIA Y CONFLICTOS

Si el usuario escribe algo ambiguo como `/mode`, sin argumentos:

```
\(^ᴗ^)/  /mode
  ▐▓▌  │
       │  ¿Qué quieres hacer?
       │  ▸ get       — muestra modo actual
       │  · set       — cambiar modo
       │  · history   — historial de cambios
```

Si escribe `/modal` (typo), el sistema sugiere:

```
\(^ᴗ^)/  /modal
  ▐▓▌  │
       │  ✗ comando no encontrado: modal
       │
       │  ¿Quisiste decir?
       │  /mode      — cambiar modo Plan/Approval/Auto
       │  /modelo    — seleccionar modelo + contexto
```

---

## 10. CRITERIOS DE ACEPTACIÓN

### UI CLI
- [ ] La mascota B (`\(^ᴗ^)/` etc.) aparece en todos los prompts
- [ ] Los ojos de la mascota cambian según estado (thinking, done, error, etc.)
- [ ] El autocompletado de comandos internos funciona con Tab
- [ ] `/help` muestra todas las categorías ordenadas
- [ ] `/help <comando>` muestra sintaxis, ejemplos y notas

### Comandos internos
- [ ] `/provider set` cambia el provider activo instantáneamente
- [ ] `/modelo list` retorna modelos disponibles del provider
- [ ] `/mcp add` registra un servidor MCP nuevo
- [ ] `/skill enable` activa una skill para todos los coordinadores
- [ ] `/mode set` cambia el modo y refleja en la UI
- [ ] `/task list` retorna tareas ordenadas por recencia
- [ ] `/narrative search` usa FTS5 y retorna relevancia ordenada
- [ ] `/ace status` muestra estado del aprendizaje
- [ ] `/doctor` completa diagnóstico en < 5 segundos

### Seguridad
- [ ] Las API keys nunca se muestran en pantalla ni en logs
- [ ] `/provider add` solicita clave via stdin sin echo
- [ ] Las keys se guardan en Bun.secrets (OS keystore), no en SQLite

---

*Hive-Code · Especificación v1.1 · Mascota ASCII + Comandos Internos*
*@johpaz · Mayo 2026*
*"Colmena de agentes. Interface natural. Construido en Colombia."*