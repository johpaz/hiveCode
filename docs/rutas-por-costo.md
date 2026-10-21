# Plan: rutas por coste — cuándo usar el enjambre y cuándo no

> Estado: propuesta. No implementado. Escribido a partir del benchmark del 21-oct-2026
> (`bench/tasks/inventario`, `bench/tasks/tareas`) y de la medición de una corrida real
> del binario con `opencode-go/minimax-m3.1-flash-free`.

## 0. El hallazgo

Los dos prompts del banco de pruebas salen por la **ruta completa de Spec Kit**:

| prompt | longitud | `classifyTask` | por qué |
|---|---|---|---|
| `inventario` | 1 695 chars | `complex` | «Crea un proyecto…» + longitud > 600 |
| `tareas` | 1 782 chars | `complex` | «Crea un proyecto…» + longitud > 600 |

Con esa ruta, una corrida real midió (binario, modelo `minimax-m3.1-flash-free`):

- **9 ejecuciones de agente** para escribir un CLI de cinco comandos: `bee` (14 turnos) → `planner` (15) → 2 `scout` (15 y 10) → `bee` ejecutor → `spawn-*` → `builder`.
- **1,9 M tokens de entrada y 120 K de salida en los primeros 14 minutos**, con 213 llamadas a herramientas.
- Dos workers **bloqueados** y dos **dedicados a descubrir capacidades** («descubrir y usar las herramientas de ejecución», «probar parse_ast sobre un archivo trivial») en vez de construir.
- 1,9 M tokens reenviados en cada turno (≈27 K por turno) porque cada turno reenvía el contexto completo.
- En el `run2` anterior, con el mismo engranaje: **39 min de mediana y 0 % en `tareas`** (2 de 3 corridas sin entregar nada).

Para el mismo trabajo, el mismo día y con el mismo prompt: **claude 0,6 min / 31 de 31**, **codex 1,8 min / 31 de 31**, **opencode 6,9 min / 31 de 31**.

### La paradoja

`classifyTask` (`packages/core/src/harness/adaptive-scheduler.ts:156`) decide con **expresiones regulares sobre el texto** y con un tope de longitud. Las dos señales que nos mandaron a la ruta pesada son:

1. la **forma de la frase** («crea un proyecto»), y
2. la **longitud del enunciado** (> 600 caracteres).

Ninguna de las dos dice nada del **tamaño del cambio**. Y hay un efecto perverso: **un contrato preciso y detallado —el tipo de enunciado que hace la tarea más fácil— es precisamente lo que dispara la ruta más cara**. El benchmark se unfair consigo mismo: cuanto mejor se especifica, más caro sale.

Además, la longitud no mide nada: un enunciado de 600 caracteres puede ser «borra el fichero X» (mutación de una línea) o una migración de ocho servicios. Y un enunciado de 200 caracteres puede ser «haz que la app soporte multi-tenant» (meses de trabajo).

## 1. La regla: el tamaño de la decisión, no el tamaño del texto

Separar tres cosas que hoy están mezcladas en un único `classifyTask`:

| dimensión | qué es | ejemplo |
|---|---|---|
| **intención** | ¿hay que mutar algo? | `crea`, `fix`, `borra` → sí; «¿qué hace X?» → no |
| **alcance del cambio** | cuántas áreas, contratos y ficheros toca | 1 fichero y 5 comandos = acotado; 8 servicios y una migración = grande |
| **calidad del enunciado** | cuánta información trae la persona | un contrato detallado **reduce** la incertidumbre, no la aumenta |

La ruta debe decidirse por la **intención + el alcance**. La calidad del enunciado debe **restar** coste, nunca sumarlo: un enunciado preciso es la señal de que la tarea está acotada y se puede hacer en un paso.

**Señal nueva, disponible y barata: la enumeración del propio contrato.** Los enunciados del banco declaran sus propios límites: «5 comandos», «3 endpoints», «un archivo». Contarlas es barato y es evidencia directa de acotamiento.

**Decidido: el estimador mira el enunciado *y* el proyecto.** El enunciado aporta la intención y las enumeraciones; el proyecto aporta el contexto que el enunciado no puede saber: ficheros que ya existen, scripts de `package.json`, si hay suite de tests, tamaño del repo, APIs en juego. En un codebase grande el enunciado solo no alcanza («hazlo como el módulo X» no dice nada del tamaño del cambio).

El coste es leer el repo, pero esa lectura la hace el harness **una vez**, antes de invocar al modelo, y el resultado es el mismo manifiesto que alimenta §3.3. No es un gasto nuevo: es el que ya se hacía tarde y mal, en forma de turnos de exploración.

## 2. Tres rutas, con presupuesto y con verificación distinta

| ruta | cuándo | runs | tokens objetivo | tiempo objetivo | verificación |
|---|---|---|---|---|---|
| **R0 · conversación** | no hay mutación | 1 (BEE) | < 50 K | < 1 min | ninguna |
| **R1 · cambio acotado** *(nuevo default)* | mutación en un área, sin contrato nuevo, ≤ N artefactos | 2–3 (BEE + builder + 1 reparación) | ≤ 1,5 M | ≤ 10 min | **determinista**: tests + tipos + build |
| **R2 · feature** | área nueva, migración, refactor amplio, contratos que cruzan módulos, ambigüedad real | 8–11 (Spec Kit) | ≤ 12 M | ≤ 45 min | determinista + Quality Gate por modelo + 2 ciclos de reparación |

R0 y R2 ya existen. **R1 es el camino que falta**: hoy `simple_change` existe pero (a) no es configurable, (b) no tiene verificación, y (c) nunca se alcanza con un enunciado largo — que es justo el caso más común.

## 3. Las tres decisiones que hacen que R1 sea ágil **y** preciso

### 3.1 Verificación determinista, no por modelo

**Decidido: en R1 la verificación es sólo determinista** (tests + tipos + build). Sin gate por modelo.

Hoy `simple_change` **no tiene Quality Gate** (`profile-harness.ts:282-306`): el builder escribe y BEE juzga el handoff con el texto. Eso no es verificación, es confianza.

La versión precisa y barata de la verificación es **ejecutar el proyecto**: `code_test` + `check_types` + `code_build` sobre el resultado. Cuesta segundos, no minutos, y no se equivoca. Si el proyecto tiene `bun test`, la respuesta es binaria y verificable.

- R1: verificación determinista + **1** ciclo de reparación si falla. Nada más.
- R2: verificación determinista **antes** del Quality Gate por modelo (si el código no compila, no tiene sentido pedirle a un modelo que lo juzgue) + el gate que ya existe.

El `verifier` LLM no se elimina de R2: se guarda para lo que de verdad necesita juicio (criterios de aceptación, cruces de contrato, calidad del diff), que es donde los modelos se diferencian de verdad.

**Consecuencia que hay que aceptar:** R1 no cubre lo que las pruebas no ven (nombres, estructura, legibilidad). Se acepta a cambio de que cada tarea pequeña cueste minutos y no media hora. Si el banco de pruebas muestra que R1 pierde puntos frente a R2, el arreglo es del estimador de alcance, no un gate nuevo.

### 3.2 Empezar pequeño y escalar con evidencia

Ninguna ruta se paga por adelantado. R1 se intenta primero siempre que el cambio sea candidato, y se **escala a R2 sólo con evidencia**:

- las pruebas deterministas fallan dos veces seguidas, o
- el diff toca más archivos/áreas de los que la estimación presuponía, o
- el enunciado nombra contratos que cruzan módulos (migración de esquema, API nueva pública, cambio de autenticación).

Si el modelo duda, R1 se lo dice al usuario en el resumen: «esto parecía acotado; si necesitabas X, dímelo». El coste de equivocarse hacia abajo es un ciclo de reparación; el de equivocarse hacia arriba es 39 minutos y 13 M tokens.

### 3.3 Contexto calculado, no descubierto

Dos de los workers de la corrida se gastaron la tarea **preguntando qué herramientas había** (`search_knowledge` con «git commit», «memory», «bash», «bun», «airtable github»), y el harness lo registra como repetición (`Repeat nudge: search_knowledge … streak=3`).

La causa es de prompt, no de modelo: el loadout mínimo son 4 herramientas (`search_knowledge`, `notify`, `report_progress`, `save_note`) y el system prompt **manda** a buscar el resto (`context-compiler.ts:621-634`). El modelo no puede saber qué tiene sin preguntar, y preguntar cuesta turnos.

Arreglo: el prompt lleva **el manifiesto real** —herramientas nativas disponibles, skills del proyecto, comandos del `package.json`, fichero de test, APIs existentes— calculado por el harness antes de invocar al modelo. `search_knowledge` sigue ahí para lo que no se puede listar (MCP), pero deja de ser la puerta de entrada habitual.

## 4. Descubrimiento: quitar la causa, no sólo el síntoma

| medida | Dónde | Efecto |
|---|---|---|
| Manifiesto de herramientas y skills en el prompt | `context-compiler.ts` | −3 a −8 turnos por run de exploración |
| `search_knowledge` exenta de la cuenta de dominancia, o con umbral propio | `agent-loop.ts:276-286` | hoy 3 búsquedas seguidas = aviso, 5 = run bloqueado; al ser read-only nunca reinicia el contador (`noteProgress` sólo cuenta escrituras) |
| Techo de 2 búsquedas de capacidad por run, contadas por ventana | nuevo en `agent-loop.ts` | corta el «descubrir qué hay» antes de que el modelo lo haga 5 veces |
| Cancelar `spawn-*` cuyo objetivo sea descubrir capacidades | `tools/agents/index.ts` (patrón de objetivo) | 2 de 9 runs eran esto |

## 5. El modelo también pesa en la ruta

El fallo que vimos no es sólo del harness: es **modelo débil × muchos pasos pequeños**. MiniMax M3.1 Flash resuelve una tarea en 15 turnos de exploración; un modelo fuerte resolvería el mismo trabajo en 4. Con un modelo fuerte, la ruta pesada rinde; con uno débil, la ruta pesada se multiplica (más turnos, más contexto, más reinicios de contexto).

Por eso la ruta debería considerar la capacidad del modelo, no sólo la del enunciado:

- **modelo fuerte** → se permite R2 cuando el cambio lo pide.
- **modelo débil / gratuito** → R1 por defecto, con un paso grande y bien instruido; R2 sólo con evidencia de que hace falta.

Esto también hace comparables los benchmarks: si los cuatro agentes usan el mismo modelo, la diferencia que queda es **la del harness**, que es justo lo que se quiere medir.

## 6. Presupuestos y corte honesto

Hoy `max_input_tokens`, `max_output_tokens` y `max_cost_usd` están en **0 = sin límite** (`agent-profiles.ts:259-261`), y el único tope real es el tiempo. Una corrida que va mal puede gastar 13 M tokens sin que nada lo frene.

Propuesta: presupuesto por ruta y por tarea, con **corte y reporte** al agotarlo (nunca seguir gastando hasta el tope de tiempo):

| ruta | tokens entrada | tokens salida | tiempo | runs |
|---|---|---|---|---|
| R0 | 50 K | 10 K | 2 min | 1 |
| R1 | 1,5 M | 200 K | 12 min | 3 |
| R2 | 12 M | 1,5 M | 45 min | 12 |

**Decidido: el tope es duro.** Al agotarlo la tarea se detiene y se reporta como **`budget_exceeded`**, con lo hecho hasta ese punto (ficheros, pruebas, evidencia). Nunca se sigue gastando hasta el tope de tiempo. Es un resultado distinto del éxito y del fallo de calidad: significa «esta tarea es más grande de lo que parecía», que es información accionable y además señala que el estimador de alcance se equivocó.

## 7. Cómo lo medimos

El banco de pruebas es el criterio de aceptación. Mismo prompt, mismas pruebas ocultas, mismo modelo para los cuatro agentes.

**Objetivo para `inventario` con el binario y `minimax-m3.1-flash-free`:**

| métrica | hoy | objetivo |
|---|---|---|
| ocultas | 0 % (cortada) o 100 % tras 40 min | **31/31** |
| tiempo | 40–60 min | **≤ 10 min** |
| tokens de entrada | 13 M | **≤ 1,5 M** |
| runs | 9 | **≤ 3** |

**Criterio de no regresión:** una tarea realmente grande (migración, feature multi-módulo) debe **seguir** yendo por R2, y terminar con el Quality Gate como hoy. Por eso falta en el banco una tercera tarea de tamaño grande real: hoy hay una pequeña (`inventario`) y una mediana que el clasificador considera grande sólo por la longitud del texto (`tareas`).

## 8. Fases

| fase | qué | tamaño |
|---|---|---|
| **F0 · instrumentación** | registrar la ruta elegida y **por qué** (señales que la dispararon) en el informe de la tarea; sin esto no hay forma de saber si el clasificador cambió de opinión por algo o por azar | pequeño |
| **F1 · estimador de alcance** | sustituir las señales léxicas por un estimador: nº de artefactos enumerados, áreas tocadas, contratos que cruzan módulos, longitud **sólo como último recurso**. Devuelve un peso, no una etiqueta | medio |
| **F2 · ruta R1** | nueva ruta en `ProfileHarness`: BEE + builder + verificación determinista + 1 reparación | medio |
| **F3 · manifiesto de contexto** | prompt con herramientas, skills, scripts y ficheros reales; techo de búsquedas de capacidad | medio |
| **F4 · presupuestos** | presupuestos por ruta, corte por presupuesto, `budget_exceeded` | pequeño |
| **F5 · banco de pruebas** | tercera tarea (grande real) y cuarta (mediana) para validar que R2 sigue vivo | pequeño |

F0 y F1 juntos ya cambian el resultado del benchmark; F2 es lo que lo hace barato.

## 9. Riesgos

| riesgo | mitigación |
|---|---|
| R1 sin gate por modelo deja calidad sin revisar | la verificación determinista + la exigencia de evidencia en el prompt de BEE; R1 sólo para cambios donde el proyecto ya tiene pruebas |
| el estimador nuevo clasifica mal | empezar en R1 y **escalar con evidencia** (§3.2); registrar la decisión (F0) para poder auditarla |
| R1 entrega más rápido pero peor que R2 | comparar con las pruebas ocultas: si R1 pierde puntos frente a R2 en el mismo banco, el estimador está mal, no la ruta |
| el manifiesto de contexto infla el prompt | va en el prompt **de sistema** una vez, no en cada turno; el presupuesto de tokens de §6 lo acota |

## 10. Decisiones tomadas (2026-10-21)

| # | decisión | respuesta | consecuencia |
|---|---|---|---|
| 1 | verificación de R1 | **sólo determinista** (tests + tipos + build) | R1 no cubre lo que las pruebas no ven; se acepta. Si el banco muestra pérdidas frente a R2, se arregla el estimador, no se añade un gate |
| 2 | presupuesto agotado | **tope duro**: corta y reporta `budget_exceeded` | el gasto queda acotado por ruta; «budget_exceeded» es una señal de que el estimador falló, no de que la calidad sea mala |
| 3 | señales del estimador | **enunciado + proyecto** | el harness lee el repo una vez antes de invocar al modelo; el resultado es el manifiesto de §3.3, así que el coste se paga una vez y alimenta dos cosas |
| 4 | quién elige la ruta | **el harness** (BEE obedece dentro de su ruta) | más controlable y auditable; la decisión queda registrada con sus señales (F0) |

## 11. Estado de implementación

Implementado y medido el 21-oct-2026 (F0–F3). F4 (presupuestos) y F5 (banco de pruebas) siguen pendientes.

| fase | estado | qué se hizo |
|---|---|---|
| F0 | hecha | la ruta y sus señales se guardan en la tarea (`harnessTasks.route`, `.routeSignals`, `.routeScore`) y se devuelven en el resultado del harness |
| F1 | hecha | `packages/core/src/harness/task-weight.ts`: estimador de alcance con señales del enunciado **y** del proyecto; sustituye a las regex y al tope de 600 caracteres |
| F2 | hecha | `packages/core/src/harness/deterministic-checks.ts`: verificación determinista (pruebas, tipos, build) consciente del proyecto, con **1** ciclo de reparación en la ruta acotada |
| F3 | hecha (lite) | el prompt del worker lista las herramientas que ya tiene y cómo se usa cada una; se acabaron las búsquedas de herramientas que ya estaban en la mano |
| F4 | pendiente | presupuestos por ruta con corte duro |
| F5 | pendiente | tercera tarea (grande real) y cuarta (mediana) en el banco |

Cambios de comportamiento que hubo que hacer al implementar:

- **Una comprobación que no aplica no es una comprobación fallida.** `check_types` sobre un proyecto sin `tsconfig`, o con dependencias sin instalar, sale en rojo por el entorno, no por el código. Con esa comprobación inventada, el ciclo de reparación gastaba el presupuesto arreglando un problema inexistente. Ahora hay tres estados: pasó, falló y no había nada que comprobar.
- **Los verbos de planificación son órdenes de cambio.** «planifica la migración de arquitectura» no es una conversación: sin reconocerlo, una tarea de feature se clasificaba como conversación y no ejecutaba nada.
- **El detector de repeticiones no ve variantes.** Compara llamadas *idénticas*, así que un modelo que prueba `tsc --noEmit`, `tsc --noEmit --types bun`, `bunx tsc`… no repite ninguna firma. Se añadió un detector de **fallos seguidos de la misma herramienta**, que avisa (no corta) a partir del cuarto.

### Medido sobre `bench/tasks/inventario` (mismo prompt, mismas 31 pruebas ocultas)

| agente | modelo | tiempo | tokens entrada | tokens salida | pasos | herramientas | ocultas |
|---|---|---|---|---|---|---|---|
| claude code | claude-sonnet-5-5 | 0,6 min | 0,04 M | 5 K | 3 | — | **31/31** |
| codex | gpt-6.1-sol | 1,8 min | 0,09 M | 4 K | 1 | 5 | **31/31** |
| opencode | minimax-m3.1-flash-free | 6,9 min | 1,13 M | 43 K | 32 | 31 | **31/31** |
| hivecode (binario) | minimax-m3.1-flash-free | 22,1 min | 1,53 M | 99 K | 48 | 80 | **31/31** |

**hivecode antes de estos cambios** (mismo banco, `run2`, desde el código, con `deepseek-flash`): 39,3 min de mediana, 12,92 M de tokens de entrada, 420 pasos, 625 herramientas, y **0 % en `tareas`** con 2 de 3 corridas sin entregar nada.

| | antes | ahora | mejora |
|---|---|---|---|
| tiempo | 39,3 min | 22,1 min | 1,8× |
| tokens de entrada | 12,92 M | 1,53 M | **8,4×** |
| pasos | 420 | 48 | **8,8×** |
| herramientas | 625 | 80 | **7,8×** |
| runs | 9 | 3 | 3× |
| `tareas` | 0 % (2/3 sin entregar) | sin medir | — |

La ruta pesada ya no se dispara por un contrato bien escrito: `inventario` (1 695 caracteres, «crea un proyecto») y `tareas` (1 782) salen ahora por la ruta acotada, y una migración con esquema, roles y API sigue yendo por la de feature.

**Lo que queda:** hivecode sigue siendo el más lento de los cuatro (3× opencode) y gasta un 35 % más tokens. El coste restante ya no es el engranaje: son 80 llamadas a herramientas para 18 ficheros, con un modelo que necesita descubrir cómo se ejecuta un proyecto. F4 (presupuestos) es lo que garantiza que esto no vuelva a crecer sin control.

## 12. Anatomía del coste por paso

El coste de una corrida es **pasos × contexto por paso**. Medido sobre la misma tarea:

| agente | pasos | tokens totales | tokens por paso |
|---|---|---|---|
| claude code | 3 | 0,04 M | ~13 K |
| codex | 1 | 0,09 M | ~90 K |
| opencode | 32 | 1,13 M | ~35 K |
| hivecode | 48 | 1,53 M | ~32 K |

**El contexto por paso de hivecode es normal.** La diferencia con claude no son los tokens de cada turno: son los **48 pasos frente a 3**. Con un modelo que resuelve la tarea en una llamada, da igual cuánto pese el prompt.

De dónde sale cada paso:

| origen | turnos | nota |
|---|---|---|
| el verificador (peritaje forense) | 19 | copia del repo en `/tmp`, `md5sum` para detectar drift, comprobar que las pruebas fallan sin la implementación… **después** de que el harness ya hubiera corrido la verificación determinista |
| BEE (delegar una tarea) | 6–8 | leía el contexto y buscaba herramientas antes de delegar |
| el builder (escribir 18 ficheros) | ~21 | el modelo escribe, comprueba y relee, un paso por fichero |

Y de dónde sale el contexto de cada turno (medido con el compilador de contexto):

| pieza | tokens | nota |
|---|---|---|
| skills (3 para el builder) | 4.139 | **46 % del prompt de sistema**, y se reenvían enteros en cada turno |
| esquemas de herramientas (22) | 4.074 | incluye `web_fetch`, `web_search`, `find_imports`, `parse_ast` y las `browser_*`, que un builder de un CLI no usa |
| resto del prompt | 769 | |
| historial | ~23 K | crece turno a turno: por eso el total es cuadrático en los pasos |

### Tres palancas, por tamaño

1. **Quitar el gate por modelo de la ruta acotada** (~19 turnos, ~27 % de los tokens). El plan ya lo decidió —R1 verifica con lo determinista— pero no estaba aplicado: BEE escalaba por su cuenta. Ahora el prompt de la ruta acotada dice que no llame al `verifier` y que delegue en el primer paso.
2. **BEE delega en el primer paso** (~4–6 turnos). BEE gastaba turnos descubriendo el proyecto que el builder va a mirar de todos modos.
3. **Bajar el coste fijo por turno** (~8,2 K × pasos). Dos medidas: enviar las skills como índice y cargar el cuerpo bajo demanda (como las herramientas MCP), y dar a cada worker sólo los esquemas que su tarea va a usar. Con 48 turnos, son ~390 K tokens: un 26 % del total.

La palanca 3 es la que más crece con el tiempo: el coste por turno se paga en cada paso, y los pasos son muchos.
