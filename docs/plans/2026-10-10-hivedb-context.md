# Subdivisión del enjambre y contexto por tarea

Implementación: 10 de octubre de 2026.

## Responsabilidades

Se conservan BEE, Planner, Scout, Builder, Verifier y Spider como perfiles residentes. El runtime programa las ejecuciones; BEE coordina las entregas. Una especialidad cambia instrucciones y skills seleccionadas, sin crear otro agente residente.

| Responsable | Especialidades de fábrica | Entrega |
| --- | --- | --- |
| BEE | Coordinación | Dependencias, delegación e integración |
| Planner | architecture | Requisitos, contratos y aceptación |
| Scout | repository | Símbolos, rangos y dependencias |
| Builder | backend, frontend, data, devops, integration | Cambios y evidencia de ejecución |
| Verifier | security, acceptance | Auditoría y veredicto independiente |
| Spider | web | Fuentes externas y evidencia visual cuando corresponde |

Cada perfil puede usar `spawn_agent` para una investigación independiente, una especialidad o un contexto demasiado grande. No se subdivide automáticamente cada tarea. El responsable define objetivo, aceptación, archivos, referencias y capacidades, y revisa el resultado. Los subagentes temporales no delegan ni crean otra generación. Las capacidades solicitadas deben estar dentro de las autorizadas al responsable; se conservan su perfil de permisos e instrucciones del usuario.

Por ejemplo: Planner fija el contrato; Scout localiza los símbolos; Builder reparte backend y frontend por archivos independientes y realiza la integración; Verifier revisa aceptación y seguridad; Spider investiga la documentación externa necesaria. Compartir archivos exige ejecución secuencial. Las herramientas que mutan un workspace se serializan, incluso entre sesiones. Los padres que esperan una entrega no ocupan un slot.

El límite predeterminado es cuatro llamadas activas a modelos o herramientas por sesión, configurable con `HIVE_MAX_AGENT_CONCURRENCY` (1–32). Este límite cuenta trabajo efectivo; no limita el número de tareas esperando. El timeout de un subagente propaga AbortSignal hasta su ejecución. Su executor se elimina después de terminar; el TaskDoc, resultado completo y AgentRun permanecen en HiveDB.

## Contexto desde HiveDB

El harness transmite `codeSessionId`, `codeTaskId` y `workspace`. El ámbito del runtime prevalece sobre parámetros enviados por el modelo. Una llamada antigua sin ámbito solo puede inferirlo si existe un único proyecto activo compatible; varios candidatos producen un error. Nunca se elige el proyecto global más reciente.

El índice admite TS/JS, Rust, SQL, JSON, TOML y Markdown. Guarda hashes, símbolos y rangos; los imports/dependientes de JS permiten navegación de un salto. El análisis Rust es conservador: no promete un grafo semántico completo. Se excluyen dependencias, builds, binarios, secretos habituales y symlinks fuera del proyecto.

El compilador añade un paquete automáticamente: mapa breve para BEE (presupuesto inicial de 700 tokens), evidencia dirigida para especialistas (2600), ajustado a la ventana del modelo. Incluye manifiestos resumidos, tarea, decisiones asociadas a tareas del mismo proyecto y fragmentos numerados. Las instrucciones de AGENTS.md en la raíz se conservan completas; si no caben se amplía el presupuesto o se informa del error. Un presupuesto insuficiente nunca las recorta silenciosamente.

Para ampliar evidencia:

```json
{"scope":"task","query":"render_office","paths":["src/lib.rs"],"token_budget":1600}
```

Estos son argumentos de `get_project_context`; el runtime aporta la identidad del proyecto. La respuesta contiene `context`, `references`, `version`, `estimatedTokens`, `omitted`, `scope` y `cached`. Las referencias contienen sesión, archivo/rango o ID de tarea/decisión y hash. La delegación valida los hashes y rechaza referencias obsoletas o de otro proyecto. El receptor carga evidencia sin copiar toda la conversación.

`search_knowledge` usa modo compacto automáticamente en ejecuciones de código: metadatos y referencias antes que cuerpos completos. Para consultar una skill concreta se puede solicitar explícitamente `mode: "full"` y `limit: 1`. `task_status` devuelve resúmenes por defecto; `full_result: true` recupera la evidencia completa de tareas persistidas, incluidos IDs como `subtask:spawn-…`.

El caché se valida contra el contenido actual al construir un paquete. Las escrituras de filesystem del agente actualizan el índice; inicio/reconciliación detectan cambios externos, borrados y cambios con igual mtime. Una edición por shell puede requerir reconciliación para descubrir símbolos nuevos; las lecturas dirigidas siempre consultan disco. Al recuperar un checkpoint se reconstruye el system prompt con contexto fresco y se conserva el historial causal de herramientas, que se ajusta al presupuesto antes de enviarlo al modelo.

## Consumo y oficina TUI

`agentRuns.context_metrics_json` registra estimaciones separadas de instrucciones, skills, tools, historial y proyecto, además de la estimación acumulada de entradas. Los contadores reales de entrada/salida y coste dependen de los datos que devuelve el proveedor. `getSwarmUsage(rootRunId)` suma padre y descendientes durables; `task_status` expone esa suma por ejecución raíz de la tarea. No se presenta una reducción porcentual sin medir una carga equivalente.

Los subagentes publican eventos de ciclo de vida que la oficina TUI muestra como hormigas con actividad, especialidad y responsable. No son puestos residentes adicionales. El movimiento de la oficina se deriva del estado de trabajo.

## Verificación

Fixtures aislados de HiveDB cubren aislamiento de proyectos, Rust, límites del paquete, instrucciones obligatorias, caché, cambios sin commit y mismo mtime, borrados, secretos, referencias obsoletas, herencia de capacidades, timeout, entregas durables, slots y exclusión de escritores entre sesiones. Los suites existentes comprueban loadouts, delegación, planificación y scheduling. Las pruebas usan fixtures y proveedores simulados; no requieren un servicio de embeddings nuevo ni credenciales de modelos.

## Modelo por agente en Configuración

En la pestaña Agentes, Enter abre un selector de modelos leído de HiveDB. El proveedor activo aparece primero; los modelos recién descubiertos no necesitan estar seleccionados globalmente. La opción «Usar modelo de la sesión» mantiene herencia. Elegir provider/model explícitamente guarda `model_selection: custom`; el harness y los cambios del modelo global respetan esa elección. El reseed conserva el ajuste. Se mantienen permisos y capacidades del perfil. Los campos cargan valores reales y el formulario desplaza su contenido para mantener visible el campo enfocado; guardar o cancelar vuelve a la pestaña Agentes.

La sincronización semanal no cambia preferencias del usuario. En la comprobación del 10 de octubre el gateway local devolvió 62 modelos de Gemini, incluido 3.8 Flash. Una prueba real con 3.8 Flash ejecutó un subagente de lectura, guardó su evidencia y retiró su executor. Los IDs usados para la prueba se obtuvieron del catálogo remoto, no del seed.

## Catálogo de modelos al configurar una API

Guardar una clave o activar un proveedor sincroniza su catálogo inmediatamente, sin esperar el slot semanal ni el cooldown de un intento anterior. La TUI se suscribe a `catalog:updated` para refrescar el hub cuando una sincronización de fondo termina. La selección excluye modelos ausentes del último snapshot completo, conservando sus registros para historial y el periodo de confirmación de retiro.

El importador conserva modalidades de entrada/salida, límite de salida y niveles de esfuerzo publicados por la API. Un modelo conversacional que acepta imágenes sigue siendo LLM seleccionable y expone `vision`/`multimodal`. En DeepSeek también se declara `code`, conforme a su interfaz para agentes de código. `get_available_models` ofrece modelos habilitados del proveedor activo aunque todavía no se hayan seleccionado globalmente; crear un agente respeta el mismo límite de disponibilidad.

La verificación autenticada de DeepSeek del 10 de octubre devolvió `deepseek-flash` (DeepSeek V4.1 Flash, texto+imagen) y `deepseek-v4-pro` (DeepSeek V4 Pro, texto). El snapshot TUI generado por el código corregido contiene ambos. Esta consulta lista modelos y no realiza inferencias.
