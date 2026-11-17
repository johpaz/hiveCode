# El bucle de agente

`packages/core/src/agent/agent-loop.ts` (`runAgent`, un generador asíncrono). Implementación nativa, sin LangGraph. Lo usan BEE, los workers y los subagentes: cambian el perfil y el contexto, no el bucle.

```
mensaje ─▶ compilar contexto ─▶ llamada al modelo ─▶ ¿herramientas? ─┬─ sí ─▶ ejecutar ─▶ checkpoint ─┐
                  ▲                                                  └─ no ─▶ respuesta final        │
                  └────────────────────────────────────────────────────────────────────────────────────┘
```

## Puntos de entrada

| Función | Uso |
|---------|-----|
| `runAgent(opts)` | Generador de chunks; el bucle completo. |
| `runAgentIsolated(opts)` | Ejecuta un worker con contexto aislado y devuelve su salida de texto (lo que usa `ProfileHarness`). |
| `AgentLoop` / `buildAgentLoop` | Fachada con `stream()` compatible con `providers/index.ts`. |

`AgentLoopOptions` incluye `agentId`, `userMessage`, `threadId`, `workspace`, `signal` (cancelación), `maxSteps`, `approvedExecution`, `parentRunId`, `runKind` (`worker | harness | verification | review`), `onStep`, `onToken`, `onReasoningToken`, `resume`/`resumeRunId`, `resumable`.

## Una iteración

1. **Cancelación.** Si `signal.aborted`, termina con `Generación detenida.` (`runStatus = cancelled`).
2. **Presupuestos.** Si se alcanza `max_input_tokens`, `max_output_tokens` o `max_cost_usd` del agente, termina con `needs_budget`.
3. **Checkpoint periódico** cada `checkpointEvery` iteraciones (`agentRuns.checkpoint_json`).
4. **Aviso de cierre.** Cuando quedan `WRAP_UP_STEPS_REMAINING = 3` pasos, se le dice al modelo que concluya.
5. **Llamada al modelo** (`callProfileLLM`) dentro de `withExecutionSlot`. Temperatura 0.3.
6. **Herramientas.** Por cada llamada:
   - Modo: `canExecuteTool` (bloqueos de `plan`) y confirmación (`approval`), ver [modes.md](./modes.md).
   - Se escribe un checkpoint **antes** de ejecutar, para que un fallo a mitad no repita llamadas ya hechas.
   - Un lote puede correr en paralelo si `structuralParallelism` lo permite (lecturas independientes, o delegaciones a workers distintos que no escriben el mismo workspace); las que tocan el mismo archivo se serializan.
   - Cada resultado se acota (`capToolResult`), se escribe como texto (`utils/llm-text.ts`) y se registra en telemetría (`tool_call`/`tool_done` por IPC).
7. **Detección de bucles** tras cada resultado (ver abajo) y checkpoint posterior (`post-tool`).
9. **Salida.** Si el modelo responde sin herramientas, ese texto es la respuesta. Si se agotan los pasos sin texto, hace una llamada final de síntesis; el estado queda `max_steps:<n>`.

El tope de pasos es, en orden: `opts.maxSteps`, `HIVECODE_AGENT_MAX_STEPS`, `max_steps`/`max_iterations` del agente.

## Contexto

`agent/context-compiler.ts` aplica cuatro estrategias:

1. **Escribir** fuera del contexto: scratchpad por conversación, trazas (`code_traces`), notas (`save_note`).
2. **Seleccionar**: *loadout* calculado por la base de datos al empezar el run, reglas del playbook ACE aplicables, historial selectivo (resumen más mensajes recientes).
3. **Comprimir**: `compaction.ts` resume mensajes viejos y borra resultados antiguos de herramientas (`clearOldToolResults`). Sigue «You don't need long context» (arXiv 2611.05306, https://arxiv.org/abs/2611.05306): mantener el contexto corto compactando con frecuencia, pasar un estado explícito de un tramo al siguiente y leer el historial de forma selectiva.
   - **Cuándo.** La compactación con modelo es el último recurso, así que el umbral es alto: `agent.context.compactionThreshold` (≤ 1) es la parte del espacio útil de entrada que puede ocupar el contexto **total** del turno (sistema + herramientas + historial); por defecto **0,8**. El espacio útil es la ventana por `COMPACT_RATIO` (0,8); el resto es la respuesta y el error de estimación. Como la parte fija no se puede compactar, al historial le toca lo que queda: `ratio × útil − fijo`. Con 128K y una parte fija de 10K compacta hacia los 72K de historial; con 0,6, hacia los 51K. Un valor > 1 son tokens de historial. Tres protecciones: nunca por encima del 90 % del presupuesto de historial del compilador (si no, este descartaría turnos antiguos *sin resumirlos* antes de que llegara la compactación), nunca por debajo de 2000 tokens (con una parte fija enorme compactaría en cada turno sin ganar nada) y, sin ventana conocida, 6000 tokens. La parte fija se mide en el run (sistema, skills, herramientas y paquete de proyecto) y, hasta entonces, se supone 10K. El umbral se mide sobre el historial vivo (resumen más lo posterior), la compactación se cancela con el turno y tiene tope de 60 s. La transcripción que ve el resumen crece con la ventana (de 40 mensajes y 24 000 caracteres hasta 160 y 100 000), en una sola llamada.
   - **Qué.** El resumen es un **traspaso de seis campos** (objetivo, hechos establecidos con sus valores exactos, cambios, verificación, callejones sin salida y plan). Se pide como JSON, se guarda en `SummaryDoc.structured` y su texto renderizado queda en `summary`, de modo que los hilos con un resumen libre anterior siguen funcionando. Si el modelo responde prosa se guarda como resumen libre; un JSON roto o un error del proveedor no compactan el hilo. Cada compactación lee solo lo posterior al resumen previo, que entra por su traspaso.
   - **Sin llamar al modelo (lo primero).** Cuando parte del hilo queda fuera de la ventana, el contexto se completa con ingeniería, no con un LLM, apoyándose en lo que HiveDB ya guarda:
     - **Libro de trabajo** (`agent/work-ledger.ts`): una *proyección* determinista de `toolRuns`, el registro que el bucle ya escribe en cada llamada. Dice qué archivos se modificaron y cuáles solo se leyeron, el último resultado de cada comprobación (`code_test`, `check_types`, `code_build`, `code_lint`), los últimos comandos y los **intentos que fallaron y no se repitieron con éxito**. Mismo registro, mismo libro; no añade escrituras ni llamadas al modelo.
     - **Historial indexado al guardarse** (`agent/message-memory.ts`): cada mensaje de más de 24 caracteres se indexa en segundo plano, por hilo, sin esperar a ninguna compactación.
     - **Recuperación por turno:** una consulta con lo que acaba de decir la persona trae hasta 3 mensajes antiguos relevantes que ya no están en la ventana (500 caracteres cada uno).
     - **`conversation_read`** para el resto: un mensaje por id o una búsqueda sobre todo el historial. Se carga solo cuando parte del hilo está fuera de la ventana, y está únicamente en el perfil de BEE (los workers corren aislados).
     - Todo va en la parte volátil del prompt, después del marcador de caché, así que no invalida el prefijo estable.
   - **Qué ve el modelo con un resumen.** El resumen se aplica al turno cuando cubre mensajes que ya no están en la ventana, y su aviso dice hasta qué mensaje llega. Es el último recurso: la compactación con modelo sigue existiendo para cuando el hilo realmente desborda la ventana.
   - **Una acción por contexto** (experimental, apagado): con `HIVECODE_SINGLE_ACTION=true` (`agent.context.singleActionMode`), un worker destila un estado de tarea tras cada acción y reinicia su conversación con solo la tarea y ese estado (`agent/single-action.ts`). Cuesta una llamada más al modelo por acción a cambio de un contexto que no crece; si actualizar el estado falla, el historial no se recorta. Solo en workers y en ejecuciones nuevas (una reanudada conserva su historial). **Sin evaluación de extremo a extremo todavía**: no activarlo sin medirlo con tareas reales.
   - **Medirlo.** `bun run bench:compaction` (`bench/compaction/`) planta datos exactos en conversaciones largas y mide cuántos sobreviven. La variante `recall` mide la recuperación **sin modelo ni clave**; las demás comparan los resúmenes con modelo.
4. **Aislar**: cada worker recibe su propio contexto mínimo; BEE ve el panorama.

El *loadout* inicial lo calcula `computeLoadout` (`agent/loadout.ts`) en `compileContext`, sin gastar un turno de LLM, con cuatro fuentes: el **núcleo del rol** (`loadout-core.ts`), la **ruta** del harness (coordinador) o la **especialidad** (workers), las herramientas cuyos **disparadores** aparecen en la tarea (`tool-metadata.ts`, indexados también en HiveDB) y las **skills que la BD puntúa** para la tarea (`rankSkills`: disparadores + BM25, filtradas por rol y con presupuesto de tokens). Todo se recorta al entorno del perfil: el loadout solo estrecha, nunca amplía. Lo que queda fuera se anuncia en una línea (manifiesto) y se trae con `search_knowledge`, sin tope de búsquedas; la herramienta y su skill llegan en el mensaje de resultado, no en el system prompt, para no invalidar la caché del prefijo. El loadout se fija al inicio del run: cambiarlo a mitad lo rompería. `HIVECODE_LOADOUT=full` restaura el comportamiento anterior (todo el entorno desde el turno 1) para comparar con `scripts/audit-loadouts.ts`. Qué se descubrió después de arrancar queda en `context_metrics_json.loadout.discovered`, y `scripts/loadout-report.ts` lo agrupa por rol, ruta y especialidad (con al menos 10 runs completados) para revisar los núcleos.

`context-budget.ts` calcula presupuestos por ventana de contexto del modelo (`budgetTokens`, `fitLoopMessages`, `projectPacketBudget`). `project-context.ts` arma paquetes de contexto del proyecto con rangos de código versionados (`get_project_context`).

## Detección de bucles

Dos niveles:

- **`RepeatTracker`** (en `agent-loop.ts`): misma herramienta con los mismos argumentos. `REPEAT_TOOL_CALL_NUDGE = 2` añade una corrección al resultado; `REPEAT_TOOL_CALL_LIMIT = 4` termina el run como atascado. Se vigilan las últimas `REPEAT_WINDOW = 8` firmas para ver oscilaciones A-B-A-B. Una sola herramienta sin otra intercalada avisa a las 3 (`SINGLE_TOOL_DOMINANCE_NUDGE`) y se considera girando a las 5. Las herramientas de orquestación (`task_delegate`, `task_revise`, `task_status`) están exentas: llamarlas seguidas es el trabajo.
  **Progreso reinicia la cuenta.** Repetir una llamada es un bucle solo si nada cambió entre medias. Cuando una llamada termina con éxito y modifica archivos (`fs_write`, `fs_edit`, `fs_delete`, `speckit_artifact_write`, o un comando de shell que escribe, ver `shellCommandMutates`), `RepeatTracker.noteProgress()` borra las cuentas, la ventana y la racha. Así un builder puede correr `bun test` tras cada corrección sin que lo detengan a la cuarta; en una sesión real, 12 de 31 runs de workers terminaban `blocked` por `repeated_tool_call` antes de este cambio. La misma llamada repetida sin ningún cambio sigue deteniéndose.
- **`stuck-loop.ts`**: *loop* (misma herramienta y argumentos fallando) y *stall* (nada se repite, nada falla y nada avanza; mide con una huella del progreso). Es observacional: genera un mensaje de intervención para el modelo y un estado, no termina el run por sí mismo.

## Una llamada escrita como texto que no se ejecutó

Si el modelo escribe una llamada como texto que no se puede convertir en una llamada real (marcado ilegible, o una petición que salió sin herramientas), el proveedor quita ese marcado del texto y marca la respuesta con `droppedToolMarkup`. El bucle no la toma por respuesta final: pide hasta `MAX_MARKUP_RETRIES = 2` veces que repita la llamada como llamada normal ("Tu última respuesta escribió una llamada a herramienta como texto y NO se ejecutó…"). Después sigue como siempre (pasada de síntesis). Antes, esos turnos terminaban con un resultado vacío (`model_returned_no_tool_calls_and_no_content`) y el worker quedaba a medias.

## Un turno vacío

Un turno sin texto ni llamada a herramienta no es una respuesta. Los modelos lo producen después de un tramo largo con muchas herramientas (el turno se va en pensar, o la respuesta se corta), y terminar ahí tiraba todo el trabajo hecho: en una corrida real, el run de ejecución de BEE se perdió así tras 25 minutos, y otros tres workers con él (4 de los 7 bloqueos de esa corrida). El bucle pide hasta `MAX_EMPTY_RETRIES = 2` veces que continúe ("Tu última respuesta llegó vacía…"); si sigue vacío, termina como antes (`model_returned_no_tool_calls_and_no_content`). No se aplica a `error` ni a `max_tokens`, que tienen su propio camino. Con `HIVE_LLM_RAW_LOG` se registran estas respuestas (`empty: true`, motivo de parada y cuánto pensó) para ver qué las provoca.

## Avisar cuando un run no termina

Un run que acaba `blocked`, `failed` o `needs_budget` (salvo que lo haya cancelado el usuario) emite un `StepEvent` de tipo `blocked` con el motivo en palabras (`describeBlocker`): "repitió la misma llamada (shell_executor) sin avanzar", "el modelo devolvió respuestas vacías y no pudo continuar", "agotó sus 40 pasos sin terminar"… Los códigos crudos (`repeated_tool_call:…`) siguen en la base de datos, pero ya no hace falta ir a buscarlos: el aviso sube por el harness (`agent_blocked`) hasta el chat de la TUI ([harness.md](./harness.md#avisos-de-bloqueo)).

## Avisar cuando un run no termina

Un run que acaba `blocked`, `failed` o `needs_budget` (salvo que lo haya cancelado el usuario) emite un `StepEvent` de tipo `blocked` con el motivo en palabras (`describeBlocker`): "repitió la misma llamada (shell_executor) sin avanzar", "el modelo devolvió respuestas vacías y no pudo continuar", "agotó sus 40 pasos sin terminar"… Los códigos crudos (`repeated_tool_call:…`) siguen en la base de datos, pero ya no hace falta ir a buscarlos: el aviso sube por el harness (`agent_blocked`) hasta el chat de la TUI ([harness.md](./harness.md#avisos-de-bloqueo)).

## Checkpoints y reanudación

`agent/run-store.ts` guarda un snapshot completo y reanudable de cada run (`writeCheckpoint`, `readCheckpoint`, `reclaimRun`) con un *lease* renovado (`startLeaseRenewal`, `LEASE_SECONDS`), de modo que otro proceso no pise un run vivo. `resumeRunId` retoma un run desde su checkpoint: los mensajes restaurados son los del checkpoint. Un run que se quedó corto y dejó checkpoint queda marcado como reanudable. `resumable: false` desactiva el snapshot (evals, reproducciones masivas).

## Registro causal (G9)

Cuando `HIVE_CAUSAL_LOG` está activo, el bucle emite un flujo de eventos causales por hilo (`storage/causal-events.ts`) que permite reconstruir qué llevó a cada decisión.

## Providers y llamadas en texto

`llm-client.ts` resuelve el provider (`resolveProviderConfig`) y delega en la implementación de `llm-providers/`. Algunos modelos escriben las llamadas a herramientas como texto en vez de en el canal estructurado; `openai-compat-base.ts` las recupera (ver [tools.md](./tools.md#llamadas-a-herramientas-escritas-como-texto)).
