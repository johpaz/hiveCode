# Revisión por paquetes — 2026-10-07

**Estado histórico:** los pendientes descritos abajo preceden a la implementación. Consultar [plan y validación actuales](../plans/2026-10-07-reliability-improvements.md); quedan cuatro duplicaciones justificadas.

Revisión estática del workspace actual, incluyendo los cambios de esta sesión. Se inspeccionaron los seis paquetes, sus exports y scripts. La revisión manual se concentró en configuración, credenciales, MCP, skills, workers, almacenamiento e interfaz. No equivale a leer cada línea ni a certificar ausencia de fallos. README.md conserva los cambios del usuario.

El análisis sintáctico detectó inicialmente **17 grupos de cuerpos de funciones TypeScript idénticos**, ignorando comentarios y espacios, excluyendo tests/archivos generados y comparando cuerpos de más de 100 caracteres. No detecta todos los clones con identificadores distintos. Rust se revisó aparte.

## core

**Corregido:** helpers de codeConfig repetidos en code/CLI se centralizaron en `storage/code-config.ts`, manteniendo control de versión y limpieza con null. Backup de fs_edit/fs_write se centralizó en `tools/filesystem/backup.ts`. Se corrigieron comentarios: workspace-guard rechaza acceso sin workspace, y el selector permite 12 herramientas, no 4.

**Corregido posteriormente:** encryptConfig/decryptConfig usan AES-256-GCM con nonce aleatorio y clave de 256 bits en Bun.secrets. MCP y canales esperan las operaciones asíncronas y Telegram guarda un envelope cifrado. No se guarda plaintext si el keystore falla. Los registros antiguos son legibles y se cifran al guardarse de nuevo; esta corrección no ejecutó una migración masiva de la BD personal. Los errores de autenticación del ciphertext no se interpretan como configuraciones antiguas.

**Alta prioridad, pendiente:** [mcp/hot-reload.ts](../../packages/core/src/mcp/hot-reload.ts:101) espera 500 ms y marca connected después de updateConfig sin consultar el estado real. El manager captura ciertos errores: este flujo puede persistir éxito tras una conexión fallida. El watcher detecta altas/bajas, pero no cambios de URL/headers/comando de servidores ya conocidos; sus pasadas de 2 segundos pueden solaparse y su conjunto de nombres no se reinicia al detenerlo. Conviene corregirlo conjuntamente con pruebas de ciclo de vida.

**Duplicaciones pendientes:** configuración/lookup de MCP entre initializer, watcher, gateway/server y routes/mcp; callbacks de streaming repetidos en server.ts; buildSnippet repetido entre tools/core y code/context-retriever. Extraer estos casos requiere conservar correlación, cancelación y contratos de datos.

## code

**Corregido:** resolveApiKey estaba copiada en subagent.worker y worker-handler. Ambos usan `resolveWorkerApiKey` en workers/secrets.ts, conservando el orden de resolución. Su comentario decía que no había fallback de entorno aunque lo aceptaban: quedó alineado al código. El parser consume los helpers compartidos de codeConfig. `/version` dejó de anunciar 1.0.0 fijo y toma la versión del manifest raíz, igual que la CLI.

**Pendiente:** los fallbacks LLM_API_KEY permiten reutilizar una credencial para otro provider, contradiciendo la intención anterior de claves independientes. No se eliminaron sin una migración. Las listas fijas de providers se repiten en workers/secrets, CLI/doctor y el switch de adapters de core/llm-client: conviene una fuente común de capacidades del runtime, distinta del catálogo remoto de modelos.

**Pendiente:** command-parser concentra persistencia, formularios, renderizado y muchos dominios. Existen implementaciones paralelas de providers/tasks/narrative en CLI con argumentos y resultados distintos. Deben compartir servicios manteniendo presentaciones separadas. Scribe y core/tools/narrative repiten el mapeo de ADRs; puede extraerse el DTO de almacenamiento sin mover la coordinación a core.

## cli

**Corregido:** provider-store reutiliza codeConfig y mantiene sus exports públicos. Las ramas de éxito/error de Settings usan un solo `isSettingsCommand` con límites de comando: `/skillXYZ` no coincide con `/skill`. Se alinearon las etiquetas del pipeline con sus siete niveles y la TUI: PM, ARC, ENG, QA+SEC, OPS, REV, LIB; antes persistía una tabla de ocho niveles anterior a la fusión quality.

**Alta prioridad, pendiente:** [adapters/binary.ts](../../packages/cli/src/adapters/binary.ts:272) usa `pkill -f "hive"` como fallback cuando no hay PID válido. Puede afectar otras instancias/procesos Hive. No se ejecutó durante esta revisión. Debe identificar la instancia propia mediante PID y metadata.

**Pendiente:** binary/bun-global duplican isRunning/getPid y gestión del PID. commands/doctor y commands-code/doctor ofrecen diagnósticos distintos; index.ts usa el segundo, y existe otro diagnóstico pequeño en el parser. Centralizar comprobaciones, manteniendo las vistas. Se reprodujo además un fallo del build autónomo de CLI: --outfile no permite el asset añadido por la TUI. Se corrigió a --outdir con entry-naming hivecode.js. La distribución autónoma completa del CLI todavía debe revisar los entrypoints de workers.

## mcp

**Corregido y reproducido:** el logger hijo capturaba el handler al crearse; el manager lo crea antes de setLogHandler y los logs no llegaban. Ahora el estado de configuración se comparte. setLevel asignaba un campo que nunca se consultaba: ahora se aplica y alcanza a hijos existentes. Comentarios históricos 'CORRECCIÓN 1/2/3/4' se sustituyeron por explicaciones actuales.

**Pendiente:** connectServer evita duplicados solo cuando connected, no cuando connecting: llamadas concurrentes pueden crear varios clientes/transports. updateConfig compara con JSON.stringify y puede reconectar por orden de claves; si se corrige un servidor en error no se reconecta porque wasConnected es falso. El logger sigue siendo global al módulo: distintos managers comparten handler; si se requieren instancias independientes debe inyectarse por manager.

**Pendiente:** getServerInfo enmascara ciertos nombres de headers pero expone otros campos por spread, incluido env. Revisar el contrato del dashboard con una lista explícita de campos publicables.

## skills

**Corregido y reproducido:** los datos estáticos de loadBundledSkills no entraban en cache, por lo que getSkill/listSkills no encontraban esas skills. Ahora se registran. El parser YAML duplicado entre loader y generate-bundle se centralizó en `src/frontmatter.ts`. Acepta LF/CRLF y comprueba que el YAML sea un objeto; con CRLF antes se ignoraba el nombre del frontmatter.

**Pendiente:** el generador conserva solo name/description/category/version/tools/triggers/body. El loader de archivos también admite permissions/dependencies/steps/rules/preferred_agents/examples/output_format: el bundle pierde metadata disponible en desarrollo. `SkillsConfig` declara hotReload/maxSkillSizeKB pero no los aplica. loadAllSkills no reconstruye la caché final: filtros y archivos eliminados pueden dejar entradas consultables que no están en la lista devuelta. Los recorridos managed/extra/workspace repiten estructura y se pueden compartir con precedencia explícita.

## hivetui

**Corregido y reproducido:** settings_hub recortaba por bytes; `éééé` podía provocar panic al cortar UTF-8. Ahora reutiliza ellipsize_cells. Hay pruebas de tildes, caracteres de ancho doble y ancho cero. widgets/components duplicaba text_width/truncate_cells de ui/text y ahora reexporta esas funciones conservando su API.

**Pendiente:** catálogo del backend, fallback Rust y ayuda Rust siguen siendo fuentes separadas. La ayuda menciona comandos ocultos en el menú: hay que distinguir acciones de Configuración, atajos y comandos internos. Los structs IPC y de vista con mapeos manuales son válidos, pero necesitan pruebas de defaults/tipos. MCP/skills/agentes repiten selección, hit regions y scrollbars: una lista común puede reducir divergencias sin fusionar estados de dominio.

## Validación

- Los nuevos tests reprodujeron primero los fallos de logger, caché, CRLF y Unicode; pasaron después de las correcciones.
- 128 tests Bun del conjunto audit/catalog/narrative/tasks/credenciales/IDs/index/strings pasan.
- 265 tests unitarios Rust pasan.
- 12 pruebas con TUI real de menú/Settings/snapshot de BD pasan; requirieron permiso fuera del sandbox para su puerto local de IPC, usando DB temporal.
- TypeScript pasa: `bunx tsc --noEmit`.
- Bundle CLI pasa con --outdir: 922 módulos. Compilación del binario de desarrollo Rust pasa.
- No se probaron llamadas reales a proveedores/GitHub/Telegram, no se migró el keystore ni se modificó la BD personal, y no se lanzó un servicio persistente.
- Se comprobó que los targets de exports declarados en manifests existen.

Los pendientes siguen abiertos. Esta auditoría con correcciones acotadas no afirma eliminar toda duplicación ni reparar toda la arquitectura.

## Inventario restante de cuerpos TypeScript idénticos

No todos son defectos: callbacks pequeños o IDs con prefijos distintos pueden ser similitudes intencionales.

| Función o callback | Ubicaciones |
|---|---|
| `onStep: async (step) => {                     if (signa` | [packages/core/src/gateway/server.ts:1837](../../packages/core/src/gateway/server.ts:1837); [packages/core/src/gateway/server.ts:2095](../../packages/core/src/gateway/server.ts:2095) |
| `buildSnippet` | [packages/core/src/tools/core/index.ts:163](../../packages/core/src/tools/core/index.ts:163); [packages/code/src/agent/context-retriever.ts:41](../../packages/code/src/agent/context-retriever.ts:41) |
| `isRunning` | [packages/cli/src/adapters/binary.ts:288](../../packages/cli/src/adapters/binary.ts:288); [packages/cli/src/adapters/bun-global.ts:189](../../packages/cli/src/adapters/bun-global.ts:189) |
| `getPid` | [packages/cli/src/adapters/binary.ts:320](../../packages/cli/src/adapters/binary.ts:320); [packages/cli/src/adapters/bun-global.ts:221](../../packages/cli/src/adapters/bun-global.ts:221) |
| `onToken: async (token: string) => {                    ` | [packages/core/src/gateway/server.ts:1824](../../packages/core/src/gateway/server.ts:1824); [packages/core/src/gateway/server.ts:2082](../../packages/core/src/gateway/server.ts:2082) |
| `findServer` | [packages/core/src/gateway/routes/mcp.ts:226](../../packages/core/src/gateway/routes/mcp.ts:226); [packages/core/src/gateway/server.ts:153](../../packages/core/src/gateway/server.ts:153) |
| `mapDecision` | [packages/core/src/tools/narrative/index.ts:35](../../packages/core/src/tools/narrative/index.ts:35); [packages/code/src/narrative/scribe.ts:80](../../packages/code/src/narrative/scribe.ts:80) |
| `resolvePath` | [packages/core/src/tools/cli/sandbox-bwrap.ts:148](../../packages/core/src/tools/cli/sandbox-bwrap.ts:148); [packages/core/src/tools/cli/sandbox-seatbelt.ts:231](../../packages/core/src/tools/cli/sandbox-seatbelt.ts:231) |
| `(await listNarrative())     .filter((entry) =>       en` | [packages/cli/src/commands-code/narrative.ts:78](../../packages/cli/src/commands-code/narrative.ts:78); [packages/code/src/narrative/scribe.ts:406](../../packages/code/src/narrative/scribe.ts:406) |
| `stopTyping` | [packages/core/src/channels/base.ts:111](../../packages/core/src/channels/base.ts:111); [packages/core/src/channels/telegram.ts:689](../../packages/core/src/channels/telegram.ts:689) |
| `defaultTaskId` | [packages/code/src/runtime/task-supervisor.ts:70](../../packages/code/src/runtime/task-supervisor.ts:70); [packages/code/src/workspace/leases.ts:30](../../packages/code/src/workspace/leases.ts:30) |
| `result.candidates.map((candidate) => ({       id: candi` | [packages/cli/src/commands/tasks.ts:27](../../packages/cli/src/commands/tasks.ts:27); [packages/cli/src/commands-code/extras.ts:51](../../packages/cli/src/commands-code/extras.ts:51) |
| `listModelChoices` | [packages/cli/src/commands-code/provider-store.ts:111](../../packages/cli/src/commands-code/provider-store.ts:111); [packages/cli/src/cli-ui.ts:259](../../packages/cli/src/cli-ui.ts:259) |
| `removeAllListeners` | [packages/core/src/events/agent-bus.ts:299](../../packages/core/src/events/agent-bus.ts:299); [packages/core/src/events/event-bus.ts:227](../../packages/core/src/events/event-bus.ts:227) |
