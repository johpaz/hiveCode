# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## Sin publicar

### Reescritura en Rust

hivecode es ahora un único binario en Rust sobre el SDK de Hive Agents (sin Bun ni Node); el TypeScript se eliminó del repositorio. Nuevo: `hivecode skill`, `hivecode cron`, estados de corrida `failed`, los cachés de pruebas (`__pycache__`, `.pytest_cache`…) ya no se integran. Ver `docs/rust-port.md`.

### Contexto corto y memoria selectiva

Basado en «You don't need long context» (arXiv 2611.05306, https://arxiv.org/abs/2611.05306): mantener el contexto corto compactando con frecuencia, pasar un estado explícito de un tramo al siguiente y leer el historial de forma selectiva. El diseño se portó de `hive` y `hive-sdk`; `hiveCode` no depende de ellos (tiene su propio `core`), solo de `@johpaz/hive-db`.

Medido en `hive-sdk` con `bench/compaction` (Gemini, escenarios sintéticos): la retención de datos tras varias compactaciones pasa de 1–2 % (resumen de 3–5 oraciones) a 74–97 % según el modelo, con un traspaso unas 3 veces más largo. **No se ha medido todavía en `hiveCode`**: el mismo benchmark está portado (`bun run bench:compaction`) para hacerlo.

#### Cambiado

- **La compactación conserva datos exactos.** Antes pedía un resumen de 3–5 oraciones con 300 caracteres por mensaje y 30 mensajes. Ahora pide un **traspaso de seis campos** (objetivo, hechos establecidos con sus valores exactos, cambios, verificación, callejones sin salida y plan) como JSON, lo guarda en `SummaryDoc.structured` y deja el texto renderizado en `summary`: los hilos con un resumen libre anterior funcionan sin migrar. Si el modelo responde prosa se guarda como resumen libre; un JSON roto o un error del proveedor no compactan el hilo (antes, el texto del error podía acabar como resumen). Límites nuevos: 800 caracteres por mensaje, 40 mensajes y 24 000 caracteres de transcripción.
- **Compactación incremental.** Lee solo lo posterior al resumen previo, que entra por su traspaso, y `messages_covered` es acumulado.
- **El umbral sigue al ctx del modelo, y es alto.** Era un 6000 fijo en dos sitios. Ahora `agent.context.compactionThreshold` (≤ 1) es la parte del espacio útil de entrada (ventana × `COMPACT_RATIO` 0,8) que puede ocupar el contexto **total** del turno —sistema + herramientas + historial—, por defecto **0,8**: la compactación con modelo es el último recurso, porque lo que sale de la ventana ya se recupera sin modelo (ver «Contexto sin llamar al modelo»). Al historial le toca lo que deja la parte fija, que no se puede compactar: con 128K y 10K fijos, ~72K de historial (con 0,6, ~51K). Un valor > 1 son tokens de historial. Protecciones: nunca por encima del 90 % del presupuesto de historial del compilador (si no, este descartaría turnos antiguos sin resumirlos antes de que llegara la compactación), nunca por debajo de 2000 tokens, y 6000 sin ventana conocida. La parte fija se mide en el run y hasta entonces se supone 10K. Con el 6000 fijo se compactaba al 5 % de una ventana de 128K y tarde en una de 8K. El agent loop pasa la ventana que el proveedor realmente lee y la señal del turno; la compactación tiene tope de 60 s y se cancela con el turno.
- **El resumen ve más.** La transcripción que recibe crece con la ventana (de 40 mensajes y 24 000 caracteres, el tope anterior, hasta 160 y 100 000 con ventanas grandes), siempre en una sola llamada. Con umbrales altos se acumulan decenas de miles de tokens y un tope fijo dejaba al resumen ver una fracción. Un modelo local pequeño sigue con los topes de siempre.
- **El umbral se mide sobre el historial vivo** (resumen más lo posterior), no sobre todo lo guardado; si no, pasado el umbral una vez se recompactaba cada pocos turnos.

#### Añadido

- **Contexto sin llamar al modelo** (ingeniería de software sobre lo que HiveDB ya guarda, no un LLM más): cuando parte del hilo queda fuera de la ventana, el prompt trae, en su parte volátil (después del marcador de caché):
  - **Libro de trabajo** (`agent/work-ledger.ts`): proyección determinista de `toolRuns` con los archivos modificados y leídos, el último resultado de cada comprobación, los últimos comandos y los intentos que fallaron y no se repitieron con éxito. Función pura (mismo registro, mismo libro), sin escrituras nuevas en el camino caliente.
  - **Mensajes antiguos relevantes**: los mensajes se indexan al guardarse (`agent/message-memory.ts`, segundo plano, por hilo) y cada turno trae hasta 3 que ya no están en la ventana, buscando con lo que acaba de decir la persona.
  - **`conversation_read`** (herramienta del coordinador): un mensaje por id o una búsqueda sobre todo el historial. Solo se carga cuando parte del hilo está fuera de la ventana. Está en el perfil de BEE; los workers corren aislados.
  La compactación con modelo queda como último recurso. Esto se apoya en el principio de HiveDB de que el estado es una proyección reproducible del registro.
- **Modo de una acción por contexto** (`agent/single-action.ts`), experimental y **apagado por defecto**: con `HIVECODE_SINGLE_ACTION=true` (`agent.context.singleActionMode`), un worker destila un estado de tarea tras cada acción y reinicia su conversación con solo la tarea y ese estado. Cuesta una llamada más al modelo por acción; si actualizar el estado falla no se recorta nada. Solo en workers y en ejecuciones nuevas. **Sin evaluación de extremo a extremo**: no activarlo sin medirlo con tareas reales.
- **Benchmark de compactación** (`bench/compaction`, `bun run bench:compaction`): datos plantados en conversaciones largas, con `--fake` para validar la tubería sin red. La clave sale de `Bun.secrets` y no se imprime ni se escribe. La variante **`recall`** mide la recuperación sin modelo ni clave: 100 % de los datos plantados en 3 escenarios con unos 47 tokens por consulta y 0 llamadas, **cota optimista** (la consulta es la pregunta, que comparte casi todas sus palabras con la frase plantada). La variante **`recall-paraphrase`** es la cota pesimista: la pregunta no comparte palabras con la frase plantada. Resultado (3 escenarios, 9 datos cada uno): **0 %** solo con BM25 y **15 %** con el embedder local (`HIVE_EMBEDDER=local`). La realidad cae entre las dos cotas: una persona suele repetir alguna palabra clave, pero si pregunta con otras palabras el índice por texto no lo encuentra y los embeddings ayudan poco con mensajes de relleno tan parecidos entre sí. Ese hueco lo cubre `conversation_read` (el modelo reformula la búsqueda) y, si se activa, el resumen.
- `agent.context.compactionThreshold` y `agent.context.singleActionMode` en `config.json`.
- **`HIVE_EMBEDDER=local`** (opt-in, apagado por defecto): abre HiveDB con el embedder local (`multilingual-e5-small`, ~470 MB de pesos la primera vez y ~20 ms por mensaje indexado) para que la búsqueda del historial encuentre por significado. Se decide al crear la base: una base creada sin embedder puede rechazar abrirse con él.

#### Corregido

- **La compactación se detenía en hilos largos.** Leía el historial con `getHistory()`, que devuelve los 200 mensajes **más antiguos**: pasado el mensaje ~200 cada compactación veía el mismo corte que la primera.
- **El resumen casi nunca llegaba al modelo.** El compilador solo lo aplicaba si los tokens de la propia ventana superaban 6000, y la ventana está acotada a 40 mensajes; el resumen se calculaba, se guardaba y se pagaba, pero rara vez se leía. Ahora se aplica cuando cubre mensajes que ya no están en la ventana. Los mensajes que la ventana aún contiene no se duplican en el resumen.
- Tests: `tests/runs/resume.test.ts` sustituía `llm-client` con `mock.module` y la sustitución seguía activa en los archivos siguientes del mismo proceso, rompiendo pruebas que no tenían relación (compactación, canales de la TUI). Ahora restaura el módulo real al terminar.

#### Pruebas

- `tests/compaction/long-thread.test.ts`: hilos de más de 200 mensajes, traspaso incremental, prosa y JSON roto, error del proveedor, resumen anterior sin `structured`, umbral por ventana (el mismo historial compacta en un modelo pequeño y no en uno grande), cuándo se aplica el resumen, y `conversation_read` (significado, id, aislamiento por hilo).
- `tests/compaction/work-ledger.test.ts`: el libro (pura y desde la base), el índice al guardar, y que un hilo largo trae libro y mensaje antiguo relevante con la base sin ningún proveedor ni modelo configurado, y un hilo corto no.
- `tests/compaction/bench.test.ts`: escenarios, puntuación y variantes del benchmark, sin modelo real.
- `tests/agent-loop/single-action.test.ts`: apagado por defecto, contexto reiniciado con tarea más estado, y el historial intacto si el estado no se puede actualizar.

#### Notas

- Depende de `@johpaz/hive-db` `^0.7.0`; no usa nada de lo añadido después en HiveDB (`embedQuery`, filtros de episodios), así que no hay que esperar a su publicación.
- Su memoria entre sesiones por proyecto (`conversation-memory.ts`) se mantiene tal cual.
