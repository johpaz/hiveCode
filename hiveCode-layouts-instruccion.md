# hiveCode — Instrucción de Implementación: Layouts Focus, Plan, Code y Review

**Tipo:** Instrucción para coding agent — sin código, prosa técnica  
**Aplica a:** `packages/tui/src/renderer/` y `packages/hive-ui/src/layouts/`  
**Fuente de verdad:** HiveDB vía IPC desde Bun  
**Versión:** 1.0  
**Fecha:** Mayo 2026

---

## Contexto general

Los cuatro layouts complementan al Dashboard. Cada uno responde a un momento específico del ciclo de vida de una sesión. El sistema cambia entre ellos automáticamente según los eventos IPC que emite Bun — el usuario nunca necesita navegar manualmente salvo que quiera sobreescribir el comportamiento automático con `[MODE ✎]`.

La regla de diseño de todos los layouts es la misma que la del Dashboard: el usuario debe entender el estado del sistema en menos de tres segundos sin leer logs. La diferencia es el nivel de detalle — el Dashboard es visión global, estos cuatro layouts son visión profunda de un momento específico.

---

## Layout 1 — Focus

### Cuándo está activo

Focus es el estado de reposo del sistema. Se activa cuando Bee clasifica la solicitud como `respond` o `fix` — ningún worker está corriendo, es una conversación directa entre el usuario y Bee. También es el layout de entrada al abrir hiveCode antes de enviar cualquier tarea.

### Qué problema resuelve

El paper identifica que los agentes monolíticos fallan porque el usuario no tiene visibilidad sobre el razonamiento del agente. En hiveCode, Bee es el punto de entrada y su razonamiento debe ser visible — el usuario tiene que entender por qué Bee clasificó la tarea como `respond` en lugar de `architecture`, o qué contexto de `agent_memory` está usando para responder.

### Estructura

La pantalla completa se divide verticalmente en dos zonas. La zona izquierda ocupa el 65% del ancho y es la zona de conversación. La zona derecha ocupa el 35% y es el thought stream de Bee.

**Zona izquierda — conversación**

En la parte superior muestra el header de una línea igual al del Dashboard — identidad, modo, métricas. Debajo ocupa todo el espacio disponible el historial de mensajes de la sesión actual. Cada mensaje tiene: el origen (`BEE` o `USER`) con su color — Bee en ámbar, usuario en blanco — el timestamp, y el contenido. Los mensajes de Bee que son respuestas directas (`respond`) muestran el contenido en texto plano. Los mensajes de Bee que reportan un fix aplicado muestran el nombre del archivo modificado como un elemento clickeable que navega al Layout Code enfocado en ese diff.

En la parte inferior está el input de texto. Ocupa dos líneas de alto con soporte de scroll horizontal para textos largos. El cursor es real — no simulado. A la izquierda del input está el hexágono `⬡` en el color del modo actual. Los comandos slash (`/think`, `/approve`, `/halt`, `/rollback`, `/auto`) se activan desde aquí con autocompletado.

**Zona derecha — thought stream de Bee**

Es un panel de scroll que muestra el razonamiento interno de Bee en tiempo real mientras procesa la solicitud. Los tokens de razonamiento llegan por IPC desde Bun y se muestran a medida que se generan — el usuario ve cómo Bee piensa antes de responder. El contenido viene del campo `type = reasoning` en `agent_context`.

En la parte inferior de esta zona, una vez que Bee completa su razonamiento, aparece el resultado de la clasificación: el tipo de acción elegida (`respond / fix / dispatch / architecture`) con una línea explicando por qué. Si Bee encontró registros relevantes en `agent_memory` para construir su respuesta, esta zona los lista con su tipo y contenido resumido — el usuario ve exactamente qué conocimiento acumulado de sesiones anteriores está usando Bee.

Si no hay razonamiento activo, esta zona muestra el estado del proyecto: nombre, `HIVECODE.md` resumido, número de ADRs activos, número de registros en `agent_memory` del proyecto, y el último veredicto del `@Reviewer` en sesiones anteriores.

### Transición de salida

Cuando Bee clasifica una tarea como `architecture` el sistema sale del Layout Focus. Hay una transición visual de 200ms donde el thought stream de Bee muestra la clasificación final y luego el layout cambia al Pipeline — específicamente al Layout Plan cuando `@Architect` empieza a trabajar.

---

## Layout 2 — Plan

### Cuándo está activo

Plan se activa cuando `@Architect` está generando el diseño de la solución — después de que `@ProductManager` completó el PRD si aplica, y antes de que los workers del nivel 2 arranquen. Es el momento más crítico del proceso: lo que `@Architect` decida aquí determina qué workers se van a despachar, en qué orden, y con qué contratos.

### Qué problema resuelve

El paper describe que la falta de coordinación interna es uno de los tres muros del agente monolítico. El Layout Plan hace visible exactamente cómo hiveCode resuelve ese muro — el usuario puede ver cómo `@Architect` construye el plan de fases antes de que cualquier worker toque código. En modo `approval` el usuario puede intervenir aquí antes de que el enjambre arranque.

### Estructura

La pantalla se divide en tres columnas.

**Columna izquierda — PRD activo**

Si `@ProductManager` se activó, muestra el PRD que escribió en el blackboard — el objetivo de negocio, las historias de usuario, y los criterios de aceptación. Si no hay PRD, muestra la tarea original del usuario tal como la escribió. Esta columna es de solo lectura y sirve como referencia constante para que el usuario pueda verificar que `@Architect` está respondiendo a lo que realmente se pidió.

**Columna central — Plan en construcción**

Es el centro de este layout y muestra el plan de `@Architect` construyéndose en tiempo real. A medida que `@Architect` escribe su plan en el blackboard, esta columna lo renderiza en formato legible:

Los niveles de ejecución aparecen como secciones numeradas. Dentro de cada nivel, los workers que correrán en paralelo aparecen en el mismo bloque visual con una etiqueta `PARALELO`. Los contratos TypeScript entre módulos aparecen como tarjetas compactas que muestran el nombre del contrato, el módulo origen, y el módulo destino. Los ADRs que `@Architect` genera o referencia aparecen como bloques resaltados en ámbar con el identificador del ADR y el título. Los archivos que cada worker va a tocar aparecen listados debajo de cada worker con el tipo de operación — `CREATE`, `MODIFY`, o `READ`.

Mientras `@Architect` sigue escribiendo, los elementos van apareciendo con una animación de entrada sutil — el plan se construye visualmente ante los ojos del usuario, no aparece de golpe al final.

**Columna derecha — Thought stream de @Architect**

Igual que en Focus, muestra el razonamiento interno de `@Architect` en tiempo real. El usuario puede ver qué registros de `agent_memory` está consultando `@Architect`, qué opciones descartó y por qué, y qué ADRs activos condicionaron sus decisiones. Esta columna hace explícito el valor de `agent_memory` — el usuario puede ver directamente cuándo `@Architect` descarta una opción porque ya fue validada o rechazada en sesiones anteriores.

### Controles en modo `approval`

En la parte inferior, si el modo es `approval`, aparecen tres controles una vez que `@Architect` reporta `done`. El primer control inicia la ejecución del plan — lanza los workers del nivel 2. El segundo control permite modificar el plan antes de ejecutar — abre una edición directa del plan en la columna central. El tercer control descarta el plan y solicita a `@Architect` que genere uno nuevo con instrucciones adicionales que el usuario escribe en ese momento.

Los tres controles requieren confirmación en un solo paso — no en dos como el rollback, porque el plan aún no ha modificado ningún archivo.

### Transición de salida

Cuando el plan está aprobado y el `CoordinatorManager` inicia los workers del nivel 2, el sistema transiciona al Layout Dashboard en 200ms. Si hay un solo worker en el nivel 2, transiciona directamente al Layout Code.

---

## Layout 3 — Code

### Cuándo está activo

Code se activa cuando hay exactamente un worker en ejecución activa — un `dispatch` de Bee a un único worker, o cuando el usuario hace click en la tarjeta de un worker específico desde el Dashboard. Es la vista de profundidad máxima sobre el trabajo de un worker individual.

### Qué problema resuelve

Cuando el Dashboard muestra múltiples workers en paralelo el usuario puede supervisar el sistema globalmente pero no puede ver el detalle de lo que hace un worker específico. El Layout Code es esa vista de detalle. También es el layout que aparece cuando Bee aplica un fix directo — el usuario ve exactamente qué cambió y puede aprobar o revertir.

### Estructura

La pantalla se divide en dos paneles principales y una barra inferior.

**Panel izquierdo — Diff activo**

Ocupa el 60% del ancho. Muestra el diff en tiempo real del archivo que el worker activo está modificando en este momento. El diff usa el formato estándar: líneas eliminadas con fondo rojo tenue y prefijo `-`, líneas agregadas con fondo verde tenue y prefijo `+`, líneas sin cambio en gris. El nombre del archivo aparece en la parte superior del panel con su ruta relativa completa.

Cuando el worker cambia de archivo, el panel actualiza el diff con una transición de 100ms. El historial de archivos modificados por el worker en esta sesión aparece como una lista horizontal de pestañas en la parte superior del panel — el usuario puede navegar entre los diffs anteriores del mismo worker haciendo click en la pestaña correspondiente.

Si el worker está en una iteración donde leyó un archivo pero aún no lo modificó, el panel muestra el contenido actual del archivo con las líneas que el worker consultó resaltadas sutilmente — el usuario puede ver qué está analizando el worker antes de escribir.

**Panel derecho — Estado del worker**

Ocupa el 40% del ancho y se divide en tres zonas verticales.

La zona superior muestra la identidad del worker activo: nombre, modelo que está usando, iteración actual sobre el máximo, tokens consumidos, y tiempo desde que inició. Debajo muestra su línea de intención en tiempo real — igual que en el Dashboard pero con más espacio para ser más descriptiva.

La zona media muestra el thought stream del worker — su razonamiento interno en tiempo real. El usuario ve cómo el worker analiza el código, toma decisiones de implementación, y razona sobre los constraints del blackboard. Cuando el worker lee un registro de `agent_memory` que el Context Compiler inyectó en su contexto, ese registro aparece resaltado en el thought stream con su tipo y contenido — el usuario ve cuándo el worker está aplicando conocimiento acumulado de sesiones anteriores.

La zona inferior muestra los registros del blackboard relevantes para este worker: las decisiones de `@Architect` que lo condicionan, los constraints activos en su scope, y las observaciones que otros workers escribieron sobre archivos que este worker está tocando. Esta zona hace visible la coordinación — el usuario puede ver que el worker no trabaja solo sino que está leyendo lo que otros workers escribieron.

**Barra inferior — Checkpoints y controles**

Igual que en el Dashboard — el timeline de checkpoints con los disponibles para rollback y los controles de modo. En modo `approval` cuando el worker reporta `done` aparecen los botones de aprobar el trabajo de ese worker específico o pedirle que rehaga con instrucciones adicionales.

### Comportamiento cuando Bee aplica un fix directo

Cuando Bee clasifica como `fix` y aplica el cambio directamente, el sistema transiciona al Layout Code por 30 segundos o hasta que el usuario presione una tecla. El panel izquierdo muestra el diff del fix. El panel derecho muestra el reasoning de Bee explicando qué cambió y por qué. La barra inferior muestra el checkpoint creado antes del fix y el botón de rollback si el usuario quiere revertir. Después de los 30 segundos o al presionar cualquier tecla, el sistema vuelve al Layout Focus.

### Transición de salida

Cuando el worker reporta `done` o `failed`, si hay otros workers activos en el mismo nivel el sistema vuelve al Layout Dashboard. Si era el único worker activo de la sesión el sistema vuelve al Layout Focus con el resultado reportado en el historial de conversación.

---

## Layout 4 — Review

### Cuándo está activo

Review se activa exclusivamente cuando `@Reviewer` completa su evaluación y emite su veredicto. Es el layout más importante en modo `approval` — es el momento donde el usuario toma la decisión final sobre si el trabajo del enjambre va a producción o se rehace.

### Qué problema resuelve

El paper valida que el `@Reviewer` dedicado con un modelo de élite es el gate de calidad más efectivo del enjambre. Pero el veredicto del `@Reviewer` solo tiene valor si el usuario puede leerlo, entenderlo, y actuar sobre él con confianza. El Layout Review presenta ese veredicto de forma que el usuario pueda tomar la decisión correcta en el menor tiempo posible — con toda la información necesaria y sin ruido.

### Estructura

La pantalla se divide en tres zonas.

**Zona superior — Veredicto**

Ocupa el 20% de la pantalla. Muestra el resultado del `@Reviewer` con color de fondo completo — verde para `aprobado`, verde con borde ámbar para `aprobado con observaciones`, rojo para `rechazado`. En el centro de esta zona, el veredicto en una sola palabra grande. A la derecha, el modelo que usó el `@Reviewer` — siempre el de mayor capacidad. A la izquierda, el tiempo total que tomó la sesión completa desde la tarea hasta el veredicto.

Esta zona responde a la pregunta "¿pasó o no pasó?" en menos de un segundo.

**Zona central — Detalle del veredicto**

Ocupa el 60% de la pantalla y se divide en dos columnas.

La columna izquierda muestra las observaciones del `@Reviewer` organizadas por categoría. Las categorías son: coherencia con ADRs, consistencia entre implementaciones de diferentes workers, calidad del código evaluada por el linter, hallazgos de `@SecurityAuditor` sin resolver, cobertura de tests evaluada por `@QAEngineer`, y antipatrones detectados. Cada categoría tiene un indicador de estado — verde si no hay problemas, ámbar si hay observaciones, rojo si hay problemas bloqueantes. Las observaciones están en lenguaje natural claro — no son mensajes de error de herramienta sino análisis del `@Reviewer`.

Cada observación que hace referencia a un archivo específico es clickeable. Al hacer click el sistema abre ese archivo en el panel derecho mostrando el diff relevante.

La columna derecha muestra el diff del archivo que el usuario seleccionó en la columna izquierda, o el diff del archivo más crítico según el `@Reviewer` si ningún archivo está seleccionado. El formato del diff es idéntico al del Layout Code.

**Zona inferior — Controles de decisión**

Ocupa el 20% de la pantalla. Es la zona más importante del Layout Review en modo `approval`.

Si el veredicto es `aprobado` hay dos controles: confirmar y cerrar la sesión, o revisar el detalle antes de confirmar. El control de confirmación requiere un solo paso — el enjambre ya hizo su trabajo, el usuario solo ratifica.

Si el veredicto es `aprobado con observaciones` hay tres controles: confirmar aceptando las observaciones como deuda técnica documentada, pedir a los workers afectados que resuelvan las observaciones antes de cerrar, o rechazar y rehacer con las observaciones como constraints adicionales en el blackboard.

Si el veredicto es `rechazado` hay dos controles: relanzar los workers afectados con los problemas del `@Reviewer` como constraints explícitos en el blackboard, o cancelar la sesión completa y hacer rollback al estado inicial. El control de relanzamiento muestra qué workers específicos se van a relanzar y con qué constraints nuevos — el usuario sabe exactamente qué va a pasar antes de confirmar.

Todos los controles de esta zona requieren confirmación en dos pasos — el usuario hace click, aparece un modal con el resumen de la acción, y confirma o cancela. Esto previene ejecuciones accidentales en el momento de máxima presión de la sesión.

En modo `auto` esta zona no muestra controles de decisión — muestra en tiempo real qué decisión tomó Bee automáticamente y el estado del relanzamiento si aplica.

### Lo que el Layout Review no hace

El Layout Review no muestra el código de todos los archivos modificados en la sesión — eso generaría ruido. Solo muestra los diffs de los archivos que el `@Reviewer` marcó como relevantes para su veredicto. El resto de archivos son accesibles desde el Layout Code pero no aparecen aquí a menos que el usuario los solicite explícitamente.

El Layout Review tampoco muestra el historial de la sesión — eso está en el Layout Focus. El objetivo es que el usuario llegue al Review con una sola pregunta en mente: ¿confirmo o no confirmo?

### Transición de salida

Si el usuario confirma el veredicto, el sistema activa `@Librarian` en segundo plano y vuelve al Layout Focus con un mensaje de Bee en el historial resumiendo lo que se implementó y lo que `@Librarian` escribió en `agent_memory`. Si el usuario relanza workers el sistema vuelve al Layout Dashboard. Si el usuario cancela la sesión el sistema ejecuta el rollback y vuelve al Layout Focus con el estado del proyecto restaurado.

---

## 5. Reglas Transversales a los Cuatro Layouts

### El header es universal

El header de una línea — identidad, modo, métricas — aparece en todos los layouts sin excepción. Es el único elemento que no cambia entre transiciones. El usuario siempre sabe en qué modo está y cuánto lleva la sesión independientemente de qué layout esté viendo.

### Las transiciones son informativas

Cada transición entre layouts dura entre 150ms y 300ms. Durante la transición aparece por 500ms una línea de texto que explica por qué el sistema cambió de layout — "Bee inició @Architect — cambiando a Plan", "Workers del nivel 2 activos — cambiando a Dashboard", "@Reviewer completó — cambiando a Review". Esto hace que el cambio automático de layout sea comprensible, no sorpresivo.

### El override manual es visible

Cuando el usuario sobreescribe el layout automático con `[MODE ✎]`, el header muestra un indicador permanente de que el switch automático está desactivado. El comando `/auto` lo reactiva y el header vuelve a su estado normal. Esto previene que el usuario se quede atrapado en un layout incorrecto sin saberlo.

### La checkpoint bar es universal

La barra de checkpoints aparece en todos los layouts en la parte inferior. El rollback está siempre disponible independientemente del layout activo. Esto refleja el principio arquitectónico central de hiveCode — el safety net nunca desaparece.

### Los colores de estado son consistentes

En todos los layouts, los mismos colores significan siempre lo mismo. Azul pulsando es actividad en progreso. Verde estático es completado exitosamente. Rojo pulsando es fallo o conflicto activo que requiere atención. Ámbar es una decisión o advertencia que el usuario debe leer. Gris es estado pendiente o inactivo. Esta consistencia hace que el usuario desarrolle intuición sobre el estado del sistema sin necesidad de leer texto.
