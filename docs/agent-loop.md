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
3. **Poda Jev** (`planJevIteration`, opcional). Decide si el historial acumulado sigue valiendo su costo y si el turno está terminado. Solo se ejecuta cuando hay peso que podar. Cualquier fallo deja mensajes y herramientas intactos.
4. **Checkpoint periódico** cada `checkpointEvery` iteraciones (`agentRuns.checkpoint_json`).
5. **Aviso de cierre.** Cuando quedan `WRAP_UP_STEPS_REMAINING = 3` pasos, se le dice al modelo que concluya.
6. **Llamada al modelo** (`callProfileLLM`) dentro de `withExecutionSlot`. Temperatura 0.3.
7. **Herramientas.** Por cada llamada:
   - Modo: `canExecuteTool` (bloqueos de `plan`) y confirmación (`approval`), ver [modes.md](./modes.md).
   - Se escribe un checkpoint **antes** de ejecutar, para que un fallo a mitad no repita llamadas ya hechas.
   - Un lote puede correr en paralelo si `jevWantsParallel` o `structuralParallelism` lo permiten; las que tocan el mismo archivo se serializan.
   - Cada resultado se acota (`capToolResult`), se formatea en TOON para ahorrar tokens y se registra en telemetría (`tool_call`/`tool_done` por IPC).
8. **Detección de bucles** tras cada resultado (ver abajo) y checkpoint posterior (`post-tool`).
9. **Salida.** Si el modelo responde sin herramientas, ese texto es la respuesta. Si se agotan los pasos sin texto, hace una llamada final de síntesis; el estado queda `max_steps:<n>`.

El tope de pasos es, en orden: `opts.maxSteps`, `HIVECODE_AGENT_MAX_STEPS`, `max_steps`/`max_iterations` del agente.

## Contexto

`agent/context-compiler.ts` aplica cuatro estrategias:

1. **Escribir** fuera del contexto: scratchpad por conversación, trazas (`code_traces`), notas (`save_note`).
2. **Seleccionar**: *tool loadout* mínimo por turno, reglas del playbook ACE aplicables, historial selectivo (resumen más mensajes recientes).
3. **Comprimir**: `compaction.ts` resume mensajes viejos cuando se supera un umbral y borra resultados antiguos de herramientas (`clearOldToolResults`).
4. **Aislar**: cada worker recibe su propio contexto mínimo; BEE ve el panorama.

El *loadout* inicial lo fija `minimal-loadout.ts`: `search_knowledge`, `notify`, `report_progress`, `save_note` para cualquiera, más `task_delegate`, `task_revise`, `task_status` para el coordinador. El resto se descubre en ejecución con `search_knowledge`, que añade al *loadout* la herramienta y su skill. Las skills que se cargan se derivan del conjunto de herramientas, para no anunciar capacidades que el modelo no tiene.

`context-budget.ts` calcula presupuestos por ventana de contexto del modelo (`budgetTokens`, `fitLoopMessages`, `projectPacketBudget`). `project-context.ts` arma paquetes de contexto del proyecto con rangos de código versionados (`get_project_context`).

## Detección de bucles

Dos niveles:

- **`RepeatTracker`** (en `agent-loop.ts`): misma herramienta con los mismos argumentos. `REPEAT_TOOL_CALL_NUDGE = 2` añade una corrección al resultado; `REPEAT_TOOL_CALL_LIMIT = 4` termina el run como atascado. Se vigilan las últimas `REPEAT_WINDOW = 8` firmas para ver oscilaciones A-B-A-B. Una sola herramienta sin otra intercalada avisa a las 3 (`SINGLE_TOOL_DOMINANCE_NUDGE`) y se considera girando a las 5. Las herramientas de orquestación (`task_delegate`, `task_revise`, `task_status`) están exentas: llamarlas seguidas es el trabajo.
- **`stuck-loop.ts`**: *loop* (misma herramienta y argumentos fallando) y *stall* (nada se repite, nada falla y nada avanza; mide con una huella del progreso). Es observacional: genera un mensaje de intervención para el modelo y un estado, no termina el run por sí mismo.

## Checkpoints y reanudación

`agent/run-store.ts` guarda un snapshot completo y reanudable de cada run (`writeCheckpoint`, `readCheckpoint`, `reclaimRun`) con un *lease* renovado (`startLeaseRenewal`, `LEASE_SECONDS`), de modo que otro proceso no pise un run vivo. `resumeRunId` retoma un run desde su checkpoint: los mensajes restaurados ya están podados y se omite la pasada Jev. Un run que se quedó corto y dejó checkpoint queda marcado como reanudable. `resumable: false` desactiva el snapshot (evals, reproducciones masivas).

## Registro causal (G9)

Cuando `HIVE_CAUSAL_LOG` está activo, el bucle emite un flujo de eventos causales por hilo (`storage/causal-events.ts`) que permite reconstruir qué llevó a cada decisión.

## Providers y llamadas en texto

`llm-client.ts` resuelve el provider (`resolveProviderConfig`) y delega en la implementación de `llm-providers/`. Algunos modelos escriben las llamadas a herramientas como texto en vez de en el canal estructurado; `openai-compat-base.ts` las recupera (ver [tools.md](./tools.md#llamadas-a-herramientas-escritas-como-texto)).
