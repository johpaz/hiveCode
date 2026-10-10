# Harness de agentes

Actualizado: 10 de octubre de 2026.

hiveCode sigue el modelo operativo de Hive: un coordinador (BEE) en el loop nativo que **delega a workers en
paralelo**, juzga la evidencia que vuelve y se apoya en un **oráculo de decisión** (Jev / Kev) para decidir qué
entra al prompt. No hay un DAG ejecutado por código.

## Perfiles

| Agente | Perfil | Rol |
|---|---|---|
| `bee` | `orchestrate` | Único interlocutor del usuario. Delega con `task_delegate`, juzga y consolida. |
| `scout` | `read_only` | Investigación sin modificar nada. |
| `planner` | `read_only` | Convierte un objetivo complejo en spec, plan y tareas con dueño (Spec Kit). No implementa. |
| `builder` | `write_workspace` | Implementa una tarea acotada. |
| `verifier` | `verify` | Quality Gate: reproduce los criterios de aceptación y revisa el diff. |
| `spider` | `web_automation` | Búsqueda, scraping y automatización de navegador. |

Definidos en `packages/core/src/agent/agent-profiles.ts`.

## Herramientas y skills por perfil

Una herramienta ejecuta una acción; una skill aporta instrucciones para realizarla. El perfil define las herramientas autorizadas. El compilador carga una selección dentro de ese límite, las skills base activas en HiveDB y las correspondientes a la especialidad. `search_knowledge` permite descubrir capacidades adicionales sin enviar el catálogo completo en cada turno. Descubrir una herramienta no amplía los permisos del perfil.

Hay dos listas de skills: `skills_json` conserva las declaradas por el perfil, mientras que `REQUIRED_PROFILE_SKILLS` determina la base inicial de los perfiles fijos. La selección efectiva también incluye las skills mínimas, las de especialidad y las descubiertas durante la ejecución; puede ajustarse por presupuesto y JEV/KEV. Una skill inactiva no se carga.

| Agente | Skills base iniciales | Skills declaradas en el perfil |
| --- | --- | --- |
| BEE | `task_orchestrator`, `spec-kit`, `busqueda_hivedb` | Las mismas. |
| Planner | `spec-kit`, `code_analysis`, `busqueda_hivedb` | Las mismas. |
| Scout | `file_read_and_summarize`, `code_analysis`, `busqueda_hivedb` | `file_manager`, `file_read_and_summarize`, `code_analysis`, `web_research`. |
| Builder | `test_driven_development`, `git_workflow`, `busqueda_hivedb` | Las mismas. |
| Quality Gate | `test_driven_development`, `code_review`, `code_analysis` | Las anteriores, `browser_automate`, `code_security_audit`. |
| Spider | `web_research`, `busqueda_hivedb` | `web_research`, `browser_automate`, `browser_scrape`, `web_monitor`. |

Las herramientas comunes de lectura de BEE, Planner, Scout, Builder y Quality Gate son:

- Archivos: `fs_read`, `fs_list`, `fs_glob`, `fs_exists`, `search_in_files`.
- Código y Git: `find_imports`, `parse_ast`, `git_status`, `git_diff`, `git_log`.
- Contexto y fuentes: `search_knowledge`, `get_project_context`, `web_search`, `web_fetch`.

Estas son las capacidades adicionales autorizadas de cada perfil:

| Agente | Herramientas adicionales |
| --- | --- |
| BEE | `task_delegate`, `task_revise`, `task_status`, `speckit_artifact_read`, `speckit_validate`, `speckit_converge`, `report_progress`, `save_note`. |
| Planner | `speckit_init`, `speckit_artifact_read`, `speckit_artifact_write`, `speckit_validate`, `save_note`. Puede escribir artefactos de planificación; no implementa código fuente. |
| Scout | El conjunto común de lectura. |
| Builder | `fs_write`, `fs_edit`, `fs_delete`, `shell_executor`, `check_types`, `code_test`, `code_build`, `run_script`. |
| Quality Gate | `shell_executor`, `check_types`, `code_test`, `code_build`, `run_script`, lectura/validación/convergencia de Spec Kit y navegador para reproducir aceptación. Las correcciones de código se devuelven al Builder. |
| Spider | `web_search`, `web_fetch`, `api_request`, `search_knowledge`, `get_project_context`, `fs_read`, `fs_list`, `fs_glob`, `save_note`, `report_progress`, `memory_write` y el conjunto completo de navegador Obscura. |

Todos los perfiles fijos tienen además `spawn_agent`. BEE comienza con un conjunto compacto que conserva delegación, contexto y Spec Kit; los especialistas comienzan con su conjunto autorizado. Para las especialidades de repositorio e implementación, la carga inicial omite búsqueda web: Spider se encarga de la investigación externa.

Quality Gate dispone de `browser_navigate`, `browser_snapshot`, `browser_interactive_elements`, `browser_click`, `browser_fill`, `browser_type`, `browser_select_option`, `browser_press_key`, `browser_wait_for`, `browser_wait_for_text`, `browser_evaluate` y `browser_screenshot`.

Spider dispone del conjunto completo definido por `obscuraToolNames()`: navegación, snapshot/Markdown, enlaces, formularios, extracción, interacción, esperas, evaluación, inspección de red/consola, capturas/PDF, cookies, almacenamiento de sesión y gestión de pestañas. Su disponibilidad efectiva requiere Obscura instalado y accesible. Si se comparte navegador, cada tarea debe usar su propia pestaña.

Fuentes: [perfiles](../packages/core/src/agent/agent-profiles.ts), [skills y especialidades](../packages/core/src/agent/specialties.ts), [compilador de contexto](../packages/core/src/agent/context-compiler.ts), [herramientas de navegador](../packages/core/src/tools/web/obscura.ts).

## Especialidades y subdivisión

Una especialidad selecciona instrucciones y skills; no crea otro puesto residente.

| Responsable | Especialidad | Skills añadidas |
| --- | --- | --- |
| Planner | `architecture` | La base de planificación. |
| Scout | `repository` | La base de investigación del repositorio. |
| Builder | `backend` | `code_generate`, `code_debug`. |
| Builder | `frontend` | `code_generate`. |
| Builder | `data` | `code_analysis`, `code_generate`. |
| Builder | `devops` | `cli_safe_exec`, `cli_pipeline`. |
| Builder | `integration` | `code_refactor`. |
| Quality Gate | `security` | `code_security_audit`. |
| Quality Gate | `acceptance` | `browser_automate` cuando hay aceptación visual/web/TUI. |
| Spider | `web` | `browser_scrape`, `browser_automate` cuando la tarea requiere navegador, scraping o sesiones. |

El responsable puede crear un especialista temporal para una subtarea independiente, una especialidad o un contexto demasiado grande. Lo pequeño se resuelve directamente. La entrega debe especificar objetivo, aceptación, archivos asignados y referencias de contexto. El responsable revisa e integra el resultado.

El hijo conserva el límite de capacidades y permisos del padre. No recibe `spawn_agent`, `task_delegate`, `task_revise`, `agent_create` ni `agent_archive`: solo se permite una generación temporal. Al terminar, se elimina su executor; tarea, resultado y ejecución permanecen en HiveDB. Un timeout cancela la ejecución mediante `AbortSignal`.

Ejemplo: Planner define contratos; Scout localiza símbolos; Builder subdivide backend y frontend por archivos independientes y realiza la integración; Spider investiga documentación externa; Quality Gate reproduce aceptación y revisa seguridad. Las mutaciones al mismo workspace pasan por exclusión de escritores.

Fuente: [especialistas temporales](../packages/core/src/agent/ephemeral-agents.ts).

## Delegación

- `task_delegate(worker_id, task_description, acceptance?)` ejecuta a un worker y devuelve su handoff más la
  evidencia contra los **criterios de aceptación**. Un criterio con `checkTool` se decide sin LLM; el resto lo
  juzga BEE con la evidencia (`acceptance_met`: `true` / `false` / `null`).
- **Paralelo**: varias llamadas `task_delegate` en el mismo paso corren a la vez cuando son workers distintos y
  como máximo uno puede escribir el workspace (los demás son de solo lectura), o cada escritor tiene su propio
  workspace. Esa regla estructural (`structuralParallelism`, `agent/jev-planner.ts`) decide **sin oráculo**;
  con Jev/Kev activo, además se les pregunta si las operaciones son independientes. Los lotes de lecturas
  independientes también van en paralelo. El límite predeterminado es de cuatro llamadas activas a modelos o herramientas por sesión (`HIVE_MAX_AGENT_CONCURRENCY`, de 1 a 32). Un responsable esperando a su subagente no ocupa un slot; las escrituras al mismo workspace se serializan, incluso entre sesiones.
- **Fan-in**: BEE es el fan-in. Si una entrega no cumple, `task_revise(task_id, feedback)` la devuelve al mismo
  worker, en el mismo hilo (`delegationThreadId`), con su entrega anterior y la retroalimentación.
- Cada delegación es un `TaskDoc` (`task_status` la consulta). El worker hereda `approvedExecution` del padre.

Diferencia con Hive: Hive continúa los jobs en una cola durable del gateway y despierta a BEE con un turno de
fan-in. hiveCode corre en un solo proceso, así que ese fan-in ocurre dentro del turno de BEE.

## Tareas largas (`ProfileHarness`)

`harness/profile-harness.ts` solo impone lo que debe cumplirse decida lo que decida el modelo: enrutado,
aprobaciones, presupuesto de reparación y reanudación.

1. `conversation`: BEE responde.
2. `simple_change`: BEE delega a `builder` (sin Spec Kit).
3. Tarea compleja:
   1. BEE delega el plan a `planner` → `specs/<feature>/{spec,plan,tasks}.md`.
   2. Política `approval`: gate de aprobación de la especificación (`plan` se detiene aquí).
   3. BEE ejecuta: delega las tareas listas en paralelo, juzga y usa `task_revise`; delega el Quality Gate a
      `verifier` y termina con `VERDICT: PASS|FAIL`. Ante `FAIL`, hasta 2 ciclos de reparación.
   4. BEE converge (`speckit_converge`); en `approval`, segundo gate de aprobación.

`AdaptiveScheduler` (`harness/adaptive-scheduler.ts`) ya no gobierna esta ejecución; sigue ahí por
`classifyTask`, `speckit_tasks_sync` y la cola `jobQueue`.

## Oráculo de decisión: Jev → Kev → clásico

Un modelo pequeño responde preguntas cerradas (`noul`, `choice`) sin generar texto. Decide qué historial,
tools, skills, notas y reglas entran al prompt (`planJevContext`), qué resultados viejos se omiten entre
iteraciones (`planJevIteration`) y si un lote de tools puede ir en paralelo (`jevWantsParallel`).

Prioridad, en `resolveOracles` (`agent/jev-decisions.ts`):

1. **Jev** (`typesafe/jev-1.13`, API Decisions de OpenRouter): provider `openrouter` habilitado, activo y con key.
2. **Kev** (`POST <base>/v1/systemone`, `model: "kev"`, LLM de HiveAgents): provider `hiveagents` habilitado,
   activo y con key. Sin coste por decisión.
3. **Clásico**: sin oráculo, el compilador y el loop corren como siempre.

`askJev` prueba los oráculos en ese orden: si Jev falla o está en cooldown se intenta Kev, y si ambos fallan
devuelve `null` y el turno sigue por el camino clásico. Kev reparte 8192 tokens en 2 slots (4096 por petición, medido): una petición de
más de `KEV_MAX_REQUEST_CHARS` se salta Kev en vez de pedirla. `recordOracleOverruled` aparta a un oráculo
durante 5 minutos tras 3 decisiones que el runtime tuvo que corregir.


## Dónde funcionan JEV y KEV

Son servicios auxiliares de decisión para el loop de todos los agentes, incluidos los temporales. BEE sigue siendo responsable del objetivo y del juicio de las entregas; JEV/KEV no ocupan un puesto de especialista en la oficina.

| Momento | Punto de integración | Función |
| --- | --- | --- |
| Preparar una llamada al modelo | `context-compiler.ts` → `planJevContext` | Seleccionar historial, herramientas, skills, notas y reglas relevantes. |
| Continuar una ejecución | `agent-loop.ts` → `planJevIteration` | Evaluar el siguiente paso y omitir resultados de herramientas que ya no aportan contexto. |
| Ejecutar un lote de herramientas | `agent-loop.ts` → `jevWantsParallel` | Evaluar si las operaciones pueden ejecutarse simultáneamente. |

Las decisiones no conceden permisos ni evitan los límites del runtime. Si no hay respuesta válida, siguen las reglas locales; las lecturas independientes y delegaciones compatibles pueden paralelizarse por la regla estructural.

El modelo de trabajo de los agentes y el oráculo se configuran por separado. Los agentes pueden usar DeepSeek o Gemini y seguir consultando JEV/KEV si OpenRouter/HiveAgents están habilitados, activos y tienen credenciales. Configurar DeepSeek no activa los oráculos. El estado configurado tampoco demuestra una respuesta exitosa: deben observarse decisiones o `lastSuccessAt`.

La TUI muestra disponibilidad y decisiones en la barra de estado y en la ficha del agente. Los tokens ahorrados mostrados por el oráculo son estimaciones; no constituyen una medición comparativa de ahorro total.

Fuentes: [resolución y fallback](../packages/core/src/agent/jev-decisions.ts), [decisiones](../packages/core/src/agent/jev-planner.ts).

## Contexto del proyecto y modelos por agente

HiveDB conserva índices de archivos con hashes, símbolos y rangos, tareas, decisiones, resultados y métricas. El contexto se restringe por proyecto, sesión y tarea. BEE recibe un mapa compacto con presupuesto inicial de 700 tokens; los especialistas reciben evidencia dirigida con presupuesto inicial de 2600, ajustado a la ventana del modelo. Estos presupuestos corresponden al paquete del proyecto, no al prompt completo.

`get_project_context` amplía evidencia por consulta y rutas. Las delegaciones pasan referencias validadas por hash y ámbito en lugar de copiar toda la conversación. Las instrucciones raíz de `AGENTS.md` se conservan completas. Véase [subdivisión y contexto HiveDB](plans/2026-10-10-hivedb-context.md) para caché, aislamiento, presupuestos y entrega durable.

En **Configuración → Agentes**, Enter abre el editor. El selector ofrece modelos habilitados de proveedores habilitados, excluyendo modelos deprecados o ausentes del último catálogo completo. El proveedor de la sesión aparece primero. Muestra nombre completo, proveedor e ID API; guarda el ID API, aunque la etiqueta visible incluya la versión.

«Usar modelo de la sesión» conserva herencia; elegir un modelo explícito guarda `model_selection: custom`. Cambiar el modelo global respeta los ajustes explícitos de cada agente. Permisos y capacidades se conservan.

## Oficina del enjambre

El panel **ENJAMBRE** conserva los puestos de BEE, Planner, Scout, Builder, Quality Gate y Spider. Los rótulos muestran esos roles funcionales y los sprites conservan sus personajes de fauna. El registro se envía después del handshake de la TUI y utiliza IDs canónicos para combinar puestos con telemetría. La actividad procede de eventos reales: lectura/búsqueda, ejecución, espera, finalización o error. El movimiento lleva a los personajes a las zonas asociadas a esa actividad; sin ejecución aparecen disponibles.

Los especialistas temporales aparecen como hormigas con actividad, especialidad y responsable. La representación temporal termina con su ciclo de vida; la evidencia permanece en HiveDB. Las especialidades por sí solas no añaden personajes residentes.

La implementación y sus pruebas permiten verificar estados y movimiento. Para comprobar el flujo completo en una sesión concreta, debe ejecutarse una tarea que efectivamente delegue o cree especialistas.

Fuentes: [oficina](../packages/hivetui/src/widgets/office.rs), [escena](../packages/hivetui/src/widgets/office_scene.rs).


Los perfiles de fábrica quedan fuera del archivado automático por inactividad del Curator. El arranque recupera perfiles de fábrica archivados mientras seguían habilitados; una desactivación explícita (`enabled: false`) se conserva. Los workers personalizados mantienen la política de archivo por inactividad, tomando la fecha de creación cuando todavía no tienen trazas.

Las señales de actividad inicial pertenecen a BEE. La señal de fin con identidad vacía limpia la actividad sin crear un puesto adicional. En una oficina de altura intermedia se reduce el margen superior/inferior para permitir dos filas de perfiles; los tamaños menores conservan paginación.


## Vistas de la TUI

Las cinco pestañas son **Enjambre, Plan, Mesa, Código y Revisión** (atajos 1–5). Taller se retiró porque duplicaba información del Enjambre y de Configuración.

- **Enjambre:** actividad, personajes, esperas y bloqueo de agentes por MCP.
- **Ficha del agente (`i` o `/ficha <agente>`):** capacidades, carga efectiva y decisiones del oráculo.
- **Configuración (`F2`):** proveedores, modelos, agentes, MCP, skills, GitHub y Telegram. `/habilidades` abre su sección Skills; con un agente como argumento abre su ficha.
- **Registro (`/logs`):** consulta de logs sin una pestaña adicional.

El registro de capacidades incluye las listas completas de herramientas autorizadas para que los contadores y las fichas sean fieles. Solo el resumen enviado al oráculo conserva un máximo de doce nombres por especialista.


## Delegación en modo Plan

Plan permite `task_delegate`, `task_revise`, `task_status` y `spawn_agent` para investigación, consultas técnicas y planificación. El harness delega los planes complejos a Planner; Scout aporta evidencia del repositorio y Spider fuentes externas. Los cambios pequeños llevan un plan breve y pueden apoyarse en especialistas cuando sea necesario.

Delegar no cambia el modo ni concede aprobación de implementación. Cada llamada del hijo pasa por la misma comprobación de modo del loop. Continúan bloqueados `fs_write`, `fs_edit`, `fs_delete`, `shell_executor`, ejecución de tests/build, commits/push y `task_delegate_code`. Los artefactos de planificación se crean con las herramientas específicas `speckit_*`, dentro de las capacidades de Planner. BEE reúne la evidencia y entrega el plan antes de iniciar la implementación.

El bloqueo anterior de `task_delegate` se retiró porque contradecía la instrucción del harness de delegar el plan a Planner.


### Confirmación de JEV y KEV en la TUI

Al activar OpenRouter con una API key, MESA confirma que JEV quedó configurado.
La barra inferior identifica el servicio: `JEV configurado · pendiente` antes de
la primera respuesta, `JEV activo` después de una respuesta exitosa y
`JEV enfriando` si falló y espera un reintento. Con HiveAgents identifica KEV.
El estado se envía después del handshake de la TUI y se refresca al abrir
Configuración o cambiar un provider. Guardar la clave permite usar el servicio;
no verifica por sí solo que la API de decisiones responda. Consultar este estado
no hace llamadas de inferencia. Los contadores de decisiones y ahorro aparecen
cuando hay actividad; la ficha del agente conserva su última decisión.


### Modelo y contexto del encabezado

El encabezado muestra `BEE provider · modelo`: el modelo propio del coordinador
si está configurado, o el modelo de la sesión si BEE lo hereda. `ctx` corresponde
al input del último turno de BEE frente a la ventana del modelo en el catálogo.
Antes de recibir usage se indica una estimación con `~`; al responder el provider
se usa su conteo de input. No suma output ni uso de especialistas. La suma de
consumo de la sesión continúa en las métricas del dashboard. Si faltan datos de
contexto o ventana se muestra `—` o se omite el porcentaje, sin asumir 200k.
La telemetría sigue el modelo de fallback cuando entra en uso y se conserva en
HiveDB para recuperar el último contexto al reabrir la sesión.
