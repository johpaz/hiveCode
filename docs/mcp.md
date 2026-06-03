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
3. **Descubrimiento** — Se listan las herramientas disponibles del servidor
4. **Sincronización FTS5** — Las herramientas se indexan en la BD para `search_knowledge`
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

## Hot Reload

El sistema soporta hot reload de servidores MCP sin reiniciar el gateway. Cuando se agrega o modifica un servidor via la UI/API, el manager desconecta y reconecta solo el servidor afectado.

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
