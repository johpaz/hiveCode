# MCP — Model Context Protocol

HiveCode actúa como **cliente MCP** que conecta a servidores externos para extender las capacidades del agente con herramientas de terceros.

---

## Arquitectura

```
Agent Loop
    │
    ├── Native Tools (packages/core/src/tools/)    ← siempre disponibles
    │
    └── MCP Tools (packages/mcp/src/)              ← via servidores externos
             │
             ├── stdio    → proceso local (npx, uv, etc.)
             ├── sse      → HTTP Server-Sent Events
             └── websocket → WebSocket bidireccional
```

El `MCPClientManager` gestiona el ciclo de vida de cada servidor: conexión, descubrimiento de herramientas, invocación y reconexión automática.

### Flujo de inicialización del Gateway

Al arrancar (`packages/core/src/gateway/initializer.ts`), el sistema:

1. **Carga desde DB** — selecciona `mcp_servers WHERE enabled = 1` de SQLite
2. **Merge con config** — une con `config.mcp.servers` del archivo de configuración
3. **Crea el manager** — `createMCPManager({ servers: merged })`
4. **Conecta** — `mcpManager.initialize()` registra cada servidor y ejecuta `connectAll()`
5. **Expone globalmente** — `setMCPManager(mcpManager)` para acceso desde API y agent loop
6. **Hot reload** — `startMCPHotReload(mcpManager)` escucha cambios dinámicos
7. **Agent loop** — `buildAgentLoop({ mcpManager })` pasa las herramientas MCP al agente

---

## Configuración

Los servidores MCP se almacenan en la tabla `mcp_servers` de SQLite. Se gestionan via:
- **TUI**: `Settings Hub` → sección MCP
- **CLI**: `hivecode mcp add`
- **API**: endpoint `/api/mcp`

### Estructura de un servidor

```typescript
interface MCPServerConfig {
  transport: "stdio" | "sse" | "websocket";
  enabled?: boolean;

  // Para stdio (proceso local):
  command?: string;        // Ej: "npx"
  args?: string[];         // Ej: ["-y", "@modelcontextprotocol/server-filesystem"]
  env?: Record<string, string>;  // Variables de entorno

  // Para sse / websocket:
  url?: string;            // Ej: "http://localhost:3000/sse"
  headers?: Record<string, string>;
}
```

---

## Ejemplos de Servidores Comunes

### Filesystem MCP (acceso a archivos del host)
```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/usuario/documentos"]
}
```

### GitHub MCP
```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
}
```

### Postgres MCP
```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost/db"]
}
```

### Servidor SSE remoto
```json
{
  "transport": "sse",
  "url": "http://mi-servidor:3000/sse",
  "headers": { "Authorization": "Bearer token123" }
}
```

---

## Ciclo de Vida

1. **Inicialización** — Al arrancar, el gateway carga todos los servidores con `enabled = 1` de la BD
2. **Conexión** — Se crea el transporte y el cliente MCP se conecta
3. **Descubrimiento** — `MCPClientManager.discoverCapabilities()` consulta al servidor:
   - `listTools()` → herramientas ejecutables
   - `listResources()` → recursos disponibles
   - `listPrompts()` → prompts del servidor
4. **Sincronización FTS5** — Las herramientas se indexan en `mcp_tools_fts` para que `search_knowledge` las encuentre
5. **Invocación** — El agente llama herramientas MCP igual que las nativas
6. **Reconexión** — Si el servidor se desconecta, el manager reintenta automáticamente

---

## Uso desde el Agente

Las herramientas MCP aparecen en el mismo pool que las nativas. El agente las descubre via:

```
search_knowledge(type="tools", query="github pull request")
→ retorna: github_create_pr (MCP: github), git_create_pr (native)
```

El agente no necesita saber si una herramienta es nativa o MCP — la interfaz es idéntica.

---

## Seguridad y privacidad

- **Encriptación de headers** — Los headers sensibles (autenticación) se almacenan encriptados en las columnas `headers_encrypted` / `headers_iv` de la tabla `mcp_servers`
- **Redacción de credenciales** — En la UI/TUI los tokens se ocultan: `Authorization`, `token`, `key` → `tok••••••••`
- **Fail-open** — Si un servidor MCP falla al conectar, el gateway sigue funcionando; el error se loguea pero no detiene el arranque

---

## Integración con el agente

Las herramientas MCP no son ciudadanas de segunda clase. El sistema las trata igual que las nativas:

- **Índice FTS5 separado** — Se indexan en `mcp_tools_fts` (aparte de `tools_fts` nativo) para evitar contaminar la búsqueda
- **Descubrimiento unificado** — `search_knowledge(type="mcp", query="...")` busca exclusivamente herramientas MCP
- **Namespace seguro** — Los nombres se sanitizan con `mcpToolFullName(serverName, toolName)` para cumplir las reglas de Gemini/OpenAI: solo `[a-zA-Z0-9_.\-:]`, máximo 64 caracteres, separador `__`

Ejemplo de nombre sanitizado:
```
Servidor "GitHub Server" + herramienta "create_pr"
→ github_server__create_pr
```

---

## Hot Reload

El sistema soporta hot reload de servidores MCP sin reiniciar el gateway. Cuando se agrega o modifica un servidor via la UI/API, el manager desconecta y reconecta solo el servidor afectado (`updateConfig()`).

Bajo el capó, los módulos `packages/core/src/mcp/hot-reload.ts` y `packages/core/src/mcp/tool-sync.ts` se encargan de:
- Reindexar las herramientas en FTS5 cuando cambian
- Reconectar solo el servidor afectado sin afectar los demás ni reiniciar el gateway

---

## Estado en TUI

El Settings Hub muestra en tiempo real:
- Estado de cada servidor (`connected` / `disconnected` / `error`)
- Número de herramientas disponibles por servidor
- Último error si `status = "error"`

---

## Agregar un Servidor MCP

**Via TUI (recomendado):**
1. Abrir Settings Hub (`s` desde el input principal)
2. Navegar a sección MCP
3. Completar: nombre, transporte, comando/URL, env vars
4. Guardar — el servidor se conecta automáticamente

**Via CLI:**
```bash
hivecode mcp add
```

**Via API directa:**
```bash
curl -X POST http://localhost:PORT/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"name":"mi-servidor","transport":"stdio","command":"npx","args":["-y","@mcp/server"]}'
```

---

## Referencia de archivos fuente

| Archivo | Responsabilidad |
|---|---|
| `packages/mcp/src/manager.ts` | `MCPClientManager` — ciclo de vida completo de servidores MCP |
| `packages/mcp/src/transports/index.ts` | Fábrica de transportes (stdio, SSE, WebSocket) |
| `packages/core/src/gateway/initializer.ts` | Bootstrap: carga DB + config → crea manager → hot reload |
| `packages/core/src/gateway/routes/mcp.ts` | API REST: CRUD, connect/disconnect, toggle |
| `packages/core/src/mcp/singleton.ts` | Acceso global al manager (`getMCPManager` / `setMCPManager`) |
| `packages/core/src/mcp/tool-sync.ts` | Sincronización de herramientas MCP al índice FTS5 |
| `packages/core/src/mcp/hot-reload.ts` | Watcher para reconexión dinámica sin reiniciar |
| `packages/core/src/agent/tool-selector.ts` | Selección FTS5 y sanitización `mcpToolFullName()` |
| `packages/core/src/tools/core/index.ts` | `search_knowledge` busca en `mcp_tools_fts` |
| `packages/core/src/storage/schema.ts` | Tablas `mcp_servers`, `mcp_tools`, `mcp_tools_fts` |
