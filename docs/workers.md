# Pipeline de compatibilidad: coordinadores por niveles

> **Referencia histórica.** Esta página conserva la descripción del pipeline original de
> hivecode: un coordinador (BEE) que despacha a once coordinadores por niveles de dependencia.
> El modelo vigente son **seis perfiles estables** (BEE, Planner, Scout, Builder, Quality Gate y
> Spider) con delegación por `task_delegate`; se describe en [`agent-harness.md`](./agent-harness.md).
> Los workers de este pipeline siguen empaquetándose por compatibilidad con planes y ejecuciones
> archivadas.

## Arquitectura del enjambre

### BEE — El Senior Dev orquestador

**BEE** es el único punto de entrada para todas las solicitudes. Clasifica cada mensaje en una de estas acciones:

| Acción BEE | Cuándo | Ejemplo |
|------------|--------|---------|
| `respond` | Saludo, pregunta, explicación — sin trabajo técnico | "hola", "¿qué hace este proyecto?" |
| `fix` | Bug simple en ≤ 3 archivos, sin diseño arquitectónico | "el login falla con email en mayúsculas" |
| `dispatch` | Feature puntual donde el coordinador es obvio | "agrega un test para el módulo auth" |
| `architecture` | Implementación multi-módulo, nuevas entidades, ADR necesario | "implementa notificaciones en tiempo real" |

### Flujo completo — Orquestación por niveles

```
Usuario escribe cualquier mensaje
        │
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  BEE — Senior Dev  (siempre primero)                       │
  │  Lee el proyecto, clasifica, consulta agent_memory         │
  └─────────────────────────────────────────────────────────────┘
        │
  ┌─────┴─────────────────────────────────────────────────┐
  │                                                       │
  ▼                                                       ▼
"respond" / "fix"                               "dispatch" / "architecture"
  │                                                       │
  ▼                                              Nivel 0: ProductManager
BEE responde o aplica                            PRD + historias de usuario
el fix directamente.                             + criterios de aceptación
SIN activar ningún worker.                       (solo cuando BEE decide architecture)
                                                         │
                                                Nivel 1: Architecture
                                                ADR + contratos TypeScript
                                                Plan de fases dinámico
                                                         │
                                         Niveles siguientes (paralelo por dependencias):
                                         Los coordinadores reales se determinan
                                         dinámicamente según el plan.
                                         Security se inyecta transversalmente
                                         en niveles con engineers.
                                                         │
                                         CodeReviewer
                                           (modelo máximo, veredicto final)
                                                         │
                                  ┌──────────────────────┴──────────────────┐
                                  │ APROBADO                                │ RECHAZADO
                                  ▼                                         ▼
                           Librarian (post-sesión)                Workers relanzados
                           Destila sesión → agent_memory          con constraints del reviewer
```

> **Modo inicial:** `auto`. BEE ejecuta el pipeline completo sin pausas. En modo `plan` solo muestra el ARNÉS sin ejecutar nada. En modo `approval` hace checkpoint entre cada nivel esperando confirmación del operador.

Si un worker agota sus iteraciones sin completar, **ForensicAgent** se activa automáticamente antes de cualquier relanzamiento — analiza la causa raíz y recomienda `relanzar_con_constraint`, `reasignar` o `escalar_al_humano`.

### Los 11 coordinadores del enjambre

Roster consolidado (antes 13): DBA se fusionó en BackendEngineer, MobileEngineer se fusionó en FrontendEngineer, e Integration se fusionó en CodeReviewer — los tres eran "escritores paralelos" sobre un dominio que ya tenía dueño, generando costuras de conflicto sin dividir trabajo real del LLM. Se sumó **Verifier**, que reproduce los criterios de aceptación del PRD contra el sistema real — el hueco de verificación que ni QA ni Reviewer cubrían por sí solos.

Cada worker es un **Bun Worker independiente** (proceso JS separado con su propio heap). Se comunican exclusivamente por paso de mensajes — nunca entre sí directamente. El blackboard en HiveDB es el único medio de coordinación.

---

#### BEE — Coordinador Principal
Único punto de entrada. Recibe la tarea del usuario, lee el contexto del proyecto con herramientas, consulta `agent_memory` de sesiones anteriores, y toma la decisión de ruteo. Escribe su razonamiento en el blackboard (`agent_context` type=`decision`). Observa el estado de todos los workers vía la vista `bee_awareness` y resuelve conflictos:
- Severidad `low`/`medium` → resuelve autónomamente y continúa
- Severidad `critical` o violación de ADR → emite **HALT** y escala al humano

**Herramientas:** lectura completa del proyecto + escritura (puede aplicar fixes directamente)

---

#### 1. ProductManager
Se activa cuando BEE clasifica como `architecture`, antes de cualquier diseño. Traduce requisitos ambiguos o de producto en un PRD estructurado: objetivo, historias de usuario, criterios de aceptación verificables, y constraints técnicos conocidos. Lo escribe en el blackboard como `type=decision` — Architecture lo usa como punto de partida, QAEngineer usa los criterios de aceptación para los tests.

**No inventa detalles de implementación. Herramientas:** solo lectura + `write_decision`

---

#### 2. Architecture — Diseñador de Sistemas
Se activa después de ProductManager cuando BEE clasifica como `architecture`. Lee el PRD del blackboard, los ADRs activos y los registros de `agent_memory` tipo `pattern` y `contract`. Produce:
- Un **ADR** con contexto, opciones evaluadas y decisión justificada
- Un **plan de fases con niveles de dependencia** — determina qué engineers del nivel 1 se despachan según el tipo de proyecto (web, mobile, ML, fullstack)
- **Contratos TypeScript** entre módulos

**Herramientas:** solo lectura + `write_decision`

---

#### 3. BackendEngineer — Ingeniero de Servidor
Implementa APIs, lógica de negocio, acceso a datos y el **modelo de datos** (absorbe el rol de DBA: el schema es parte del contrato de backend, no un dominio aparte). Lee el plan de Architecture y los contratos del blackboard. Al terminar escribe los endpoints y el modelo de datos implementados con sus contratos exactos para que Frontend y DataScientist los consuman. El sub-agente `db-agent` sigue disponible para el diseño de datos.

**Herramientas:** read + write completo + git + build/test/lint + `write_decision` + shell

---

#### 4. FrontendEngineer — Ingeniero de Interfaz de Cliente
Implementa UI de cliente — **web y mobile** (absorbe el rol de MobileEngineer: mismo trabajo de UI contra un único contrato de API). En modo web, verifica cada componente con `browser_screenshot` antes de darlo por completo; en modo mobile (React Native, Expo, iOS/SwiftUI, Android/Jetpack Compose) el ciclo de verificación es build+test. Si un endpoint que necesita aún no está definido en el blackboard, escribe una pregunta dirigida a Backend y continúa con las partes independientes. Al terminar documenta qué componentes creó y qué endpoints consume para que CodeReviewer valide la consistencia.

**Herramientas:** read + write completo + git + build/test/lint

---

#### 5. DataScientist — Científico de Datos / IA
Implementa modelos ML, pipelines de datos y agentes de IA. Es fundamentalmente distinto a BackendEngineer — maneja PyTorch, scikit-learn, transformers y MLOps. Coordina con BackendEngineer vía blackboard para definir el contrato del endpoint de predicciones antes de que el backend lo implemente. Reporta métricas concretas (F1, AUC, accuracy) en el blackboard, no narrativas vagas.

**Herramientas:** read + write + run_script + shell

---

#### 6. SecurityAuditor — Auditor de Seguridad
Opera en **dos modos simultáneos**:
- **Transversal** durante el nivel de engineers: corre en paralelo con Backend/Frontend/DataScientist, detecta hallazgos CRITICAL y escribe constraints en el blackboard antes de que los workers afectados continúen
- **Dedicado** en el nivel de QA: análisis completo del código producido

Categorías que siempre audita: inyecciones SQL/command, secrets hardcodeados, autenticación débil, dependencias vulnerables, XSS, exposición de datos. **No modifica código.**

**Herramientas:** solo lectura + `check_dependencies`

---

#### 7. QAEngineer — Ingeniero de Calidad
Escribe y ejecuta tests después de que todos los engineers del nivel anterior completaron. Lee los criterios de aceptación del PRD de ProductManager (si existe) para escribir casos verificables. El Context Compiler le inyecta `forensic_lessons` de sesiones anteriores para evitar repetir casos que ya causaron problemas. Si un test falla, escribe el fallo en el blackboard dirigido al worker responsable.

**Herramientas:** read + write + test runner

---

#### 8. DevOpsEngineer — Infraestructura y CI/CD
Configura pipelines de CI/CD, Dockerfiles, Terraform y configuraciones de monitoreo. Se activa después de QA y Security porque necesita conocer el estado final del código. Lee el blackboard para entender qué cambios hicieron los otros workers y actualiza la infraestructura para soportarlos.

**Herramientas:** read + write + git completo (incluyendo `git_create_pr`, `git_rollback`) + shell

---

#### 9. Verifier — Verificación de Comportamiento *(nuevo)*
Reproduce, de forma independiente, los criterios de aceptación del PRD de ProductManager contra el sistema real — no confía en que QA escribió los tests correctos ni en que el código "parece" correcto. Corre después de DevOps y antes de CodeReviewer: levanta build/servidor, ejecuta cada criterio, y prioriza siempre evidencia determinística (`code_test`, `code_build`, comandos exactos) sobre juicio propio. Si un criterio no es reproducible en el entorno, lo dice explícitamente en vez de asumir que cumple. **No modifica código.**

**Herramientas:** solo lectura + `code_test`, `code_build`, `shell_executor`, `run_script`, `write_decision`

---

#### 10. CodeReviewer — Gate de Calidad Final
Siempre usa el **modelo de mayor capacidad disponible**, independientemente del modelo configurado para los otros workers. Lee todo el blackboard, los diffs contra checkpoints, hallazgos de Security, resultados de QA, y la evidencia de Verifier. Además, **cruza contratos entre módulos** (absorbe el rol de Integration): endpoints↔consumo, modelo de datos↔queries, tipos↔imports. El Context Compiler le inyecta toda la `agentMemory` del proyecto — llega con el historial completo de lo que funcionó y lo que no.

Emite el veredicto invocando la tool **`submit_review_verdict`** (estructurada, no texto libre): un checklist de criterios de aceptación cruzados con evidencia real, categorías de estado (ok/warning/blocking), y razones específicas si rechaza.
- `aprobado` — el trabajo cumple todos los criterios
- `aprobado_con_observaciones` — aprobado, con puntos de mejora para próximas sesiones
- `rechazado: {razones específicas}` — no puede pasar a producción sin correcciones

Un test debilitado o eliminado para forzar la aprobación es motivo de rechazo automático. Si rechaza, BEE relanza los workers afectados con los constraints del rechazo. **No modifica código.**

**Herramientas:** solo lectura + `write_decision` + `check_types` + `code_test`

---

#### 11. ForensicAgent — Reflexión Forzada *(on-demand)*
Se activa en dos casos: (1) un worker alcanza su límite de iteraciones sin completar, o (2) una tarea agota sus reintentos automáticos con backoff exponencial sin resolverse — en ese caso, el análisis forense se adjunta a la escalación a revisión humana en vez de escalar solo con el error crudo. El `CoordinatorManager` nunca relanza un worker que falló por límite sin esperar el análisis del ForensicAgent.

Analiza el historial completo del worker fallido en el blackboard y produce:
1. **Qué intentó** — cada enfoque en orden cronológico
2. **Por qué falló** — causa raíz: `error_de_implementacion`, `conflicto_con_constraint`, `limitacion_del_entorno` o `problema_de_especificacion`
3. **Recomendación** — exactamente una de tres:
   - `relanzar_con_constraint: {constraint}` → el manager escribe el constraint y relanza
   - `reasignar_a: {worker}` → la tarea no corresponde a este worker
   - `escalar_al_humano: {opciones}` → requiere decisión humana

**No modifica código. Herramientas:** solo lectura del blackboard y workspace

---

#### 12. Librarian — Memoria Compuesta *(on-demand, post-sesión)*
Se activa solo cuando CodeReviewer emitió `APROBADO` o `APROBADO_CON_OBSERVACIONES`. Lee el blackboard completo y **destila** — no transcribe — el conocimiento accionable en la colección `agent_memory` de `./hivecode`. Escribe patrones, antipatrones, contratos, convenciones y lecciones forenses. Incrementa `confirmed_count` de registros que la sesión validó y depreca los que ya no aplican (`refuted_count > confirmed_count + 2`). El conocimiento no se borra — se depreca con trazabilidad.

**No modifica código de producción. Herramientas:** solo lectura + `write_memory`

---

### Paralelismo real por niveles

El `CoordinatorManager` agrupa las fases definidas por Architecture en niveles de dependencia. Todos los workers de un nivel se inician **en el mismo tick** con `Promise.all()`. El siguiente nivel solo comienza cuando todos los del nivel anterior reportaron `done`.

```
BEE (siempre primero)
  │
  ├─ respond / fix ───────► respuesta directa o fix aplicado por BEE
  │
  └─ architecture ────────► ProductManager ──► Architecture
                                                  │
                                                  ▼
                                        Plan de fases dinámico
                                                  │
                              Nivel 0 ──► Engineers según el plan
                                        (backend absorbe DBA, frontend absorbe
                                         mobile, data_scientist)
                                        + SecurityAuditor transversal
                                                  │
                              Nivel 1 ──► QA / DevOps según dependencias
                                                  │
                              Nivel N ──► Verifier (reproduce criterios del PRD)
                                                  │
                              Nivel N+1 ► CodeReviewer (modelo máximo,
                                                          absorbe Integration)
                                                  │
                              Post-sesión ► Librarian (solo si APROBADO)
```

La tabla `worker_activity` registra `started_at` y `completed_at` con `level`. Todos los coordinadores de un mismo nivel se lanzan en paralelo con `Promise.all()`.

---

## Memoria compuesta entre sesiones

El **Librarian** destila el conocimiento de cada sesión aprobada en la colección `agentMemory` de HiveDB. El **Context Compiler** la consulta por índice antes de despachar cada worker, con filtrado por dominio: cada worker recibe solo el tipo de conocimiento relevante para su rol.

| Worker | Tipos de memoria que recibe |
|--------|----------------------------|
| Architecture | `pattern`, `contract` |
| SecurityAuditor | `antipattern` |
| QAEngineer | `forensic_lesson` |
| Verifier | `contract`, `forensic_lesson` |
| CodeReviewer | todos los tipos |
| demás workers | filtrado por relevancia semántica (HiveDB index) |

Tipos de conocimiento persistido:

| Tipo | Qué registra |
|------|-------------|
| `pattern` | Enfoque que funcionó y fue aprobado por el CodeReviewer |
| `antipattern` | Enfoque que causó fallos o fue rechazado |
| `contract` | Interfaz establecida entre módulos |
| `convention` | Convención del proyecto descubierta durante la sesión |
| `forensic_lesson` | Lección de fallos analizados por el ForensicAgent |

Los registros tienen `confirmed_count` / `refuted_count`. El sistema depreca automáticamente conocimiento que ya no aplica (`refuted_count > confirmed_count + 2`). El conocimiento no se borra — se depreca con trazabilidad completa.

---
