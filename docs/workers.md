# Los Workers de hiveCode

> **Documento histórico del pipeline de compatibilidad.** El roster vigente es BEE, Scout, Builder, Verifier y Reviewer; los dominios son skills y ningún worker se inicia de forma persistente. Consulta [Agent Harness](./agent-harness.md).

hiveCode opera con **11 coordinadores principales** más **2 workers on-demand** y **18 sub-agentes especializados**. Cada worker es un **Bun Worker independiente** — proceso JS separado con su propio heap — y se comunica con el `CoordinatorManager` exclusivamente por paso de mensajes. Los workers nunca se comunican entre sí directamente; el blackboard HiveDB es el único medio de coordinación.

**Roster consolidado**: antes había 13 coordinadores. DBA se fusionó en BackendEngineer (el schema es parte del contrato de datos del backend, no un dominio aparte), MobileEngineer se fusionó en FrontendEngineer (mismo trabajo de UI de cliente contra un único contrato de API), e Integration se fusionó en CodeReviewer (la validación read-only de contratos entre módulos solapa con el reviewer de contexto limpio). Se sumó **Verifier**, un coordinador nuevo que reproduce los criterios de aceptación del PRD contra el sistema real — el hueco de verificación que ni QA (escribe tests) ni Reviewer (lee código) cubrían. La razón de fondo: los coordinadores que **leen** en paralelo escalan bien; los que **escriben** en paralelo sobre el mismo dominio generan costuras de conflicto y gastan tokens de forma redundante sin dividir trabajo real del LLM. Ver el detalle de cada fusión en su sección correspondiente más abajo.

---

## Visión general del enjambre

BEE es el punto de entrada de TODA solicitud. Si puede responder o resolver por sí mismo (saludo, pregunta, fix simple), **no activa ningún worker** — retorna directamente al usuario. Solo cuando la tarea requiere diseño o implementación multiagente entra el enjambre completo.

```
Usuario escribe mensaje
        │
        ▼
      BEE
        │
        ├── respond → responde directo, SIN workers
        ├── fix     → aplica el fix directo, SIN workers
        │
        └── architecture / dispatch → activa el enjambre:
              │
              Nivel 0: ProductManager  — PRD siempre primero
              │        (sin especificación no hay arquitectura posible)
              │
              Nivel 1: Architecture   — ADR + plan de fases + contratos
              │
              Nivel 2 (en paralelo según el tipo de proyecto):
              │     ├── BackendEngineer   ──┐  (absorbe DBA: modelo de datos incluido)
              │     ├── FrontendEngineer    │  Promise.all()  (absorbe Mobile: web + mobile)
              │     ├── DataScientist       │
              │     └── Security (transversal, siempre)
              │
              Nivel 3 (en paralelo):
              │     ├── QAEngineer
              │     └── Security (dedicado)
              │
              Nivel 4:
              │     └── DevOps            — CI/CD, Docker, PR
              │
              Nivel 5:
              │     └── Verifier          — reproduce los criterios de aceptación del PRD
              │                              contra el sistema real, independiente de QA/Reviewer
              │
              Nivel 6:
                    └── CodeReviewer      — gate final, modelo máximo
                                             (absorbe Integration: cruza contratos entre módulos)

On-demand (fuera del pipeline):
  ├── Librarian      — post-sesión aprobada por CodeReviewer
  └── ForensicAgent  — cuando un worker agota sus iteraciones, o cuando una tarea
                        agota sus reintentos automáticos sin resolverse
```

### Modos de operación y qué puede hacer BEE en cada uno

El modo inicial siempre es **`auto`** (valor por defecto en `repl-state.ts` cuando no hay configuración previa). BEE recibe el modo activo en cada `CoordinatorTask` y adapta su comportamiento:

| Modo | BEE puede… | Herramientas de escritura | Workers |
|------|-----------|--------------------------|---------|
| **`auto`** | Responder, aplicar fixes, despachar workers, ejecutar todo el pipeline sin pausas | Habilitadas | Se ejecutan sin confirmación |
| **`plan`** | Solo leer, razonar y mostrar el ARNÉS al usuario | **Deshabilitadas** | No se ejecutan — solo se muestra el plan |
| **`approval`** | Ejecutar el pipeline completo, pero hace pausa (checkpoint) entre cada nivel para que el operador confirme | Habilitadas | Se ejecutan nivel a nivel con confirmación manual |

**En modo `plan`:** BEE devuelve el bloque ARNÉS (stack detectado, hipótesis, decisiones, contratos, archivos estimados, riesgos) y no ejecuta nada. Los workers quedan en estado `pending`. Las acciones `respond` y `fix` también pasan por el flujo de plan — BEE las documenta pero no las aplica.

**En modo `approval`:** el `CoordinatorManager` llama a `onApprovalCheckpoint` entre cada nivel. El operador puede aprobar, saltar o cancelar. Si cancela, la tarea queda en estado `paused` con el checkpoint guardado para reanudar.

---

## Cómo funciona cada worker internamente

Todo worker ejecuta el mismo loop en `worker-handler.ts`, parametrizado por su system prompt:

```
1. Recibe CoordinatorTask con:
   - system prompt del rol
   - compiledContext (skills + playbook + memoria relevante)
   - tools permitidas para su rol
   - narrative de la sesión

2. Loop:
   LLM call
     ├── Tool calls → envía TOOL_CALL al manager → espera TOOL_RESULT → continúa
     └── Respuesta final → envía RESULT al manager → termina

3. Si tokens > 75% del límite: compacta mensajes intermedios y continúa

4. Si alcanza MAX_ITERATIONS sin terminar: CoordinatorManager activa ForensicAgent
```

Cada worker opera en modo **lectura-acción**: primero lee el estado real del proyecto con herramientas, luego actúa. Ningún worker asume nada — todo lo verifica.

---

## Los 11 coordinadores

---

### 1. BEE — Senior Developer & Orchestrator

**Archivo:** `packages/code/src/workers/bee.worker.ts`
**Rol en el pipeline:** Primer y único punto de entrada para toda solicitud del usuario.

BEE es el coordinador principal del enjambre. Recibe cada mensaje del usuario, lee el contexto real del proyecto con herramientas, y clasifica la solicitud en una de 4 acciones posibles:

| Acción | Cuándo | Workers activados | Qué hace |
|--------|--------|:-----------------:|----------|
| `respond` | Saludo, pregunta, explicación sin trabajo técnico | **Ninguno** | Responde directamente al usuario y cierra la tarea |
| `fix` | Bug simple, ≤ 3 archivos, sin diseño arquitectónico | **Ninguno** | Lee y aplica el fix con sus propias herramientas de escritura |
| `dispatch` | Feature puntual, coordinador obvio | Solo el especialista | Delega directamente al coordinador específico |
| `architecture` | Feature multi-módulo, decisiones no triviales | Enjambre completo | ProductManager → Architecture → engineers → review |

**`respond` y `fix` no activan ningún worker.** El `CoordinatorManager` cierra la tarea directamente después de que BEE responde (línea 387–398) o aplica el fix (línea 401–420). No hay fases, no hay pipeline, no hay blackboard de sesión en uso.

**Protocolo de lectura de archivos** (obligatorio para todos los workers):
- Archivos < 100 líneas: `fs_read()` completo
- Archivos 100–500 líneas: `parse_ast()` primero → `fs_read(offset, limit)` del fragmento
- Archivos > 500 líneas: `parse_ast()` → `code_search()` → `fs_read(offset, limit)` — **nunca el archivo completo**

**Output format (JSON estructurado):**
```json
{
  "action": "respond|fix|dispatch|architecture",
  "content": "respuesta o resumen del fix",
  "reason": "por qué tomó esta decisión",
  "phases": [{ "coordinator": "backend", "description": "...", "dependsOn": [] }],
  "filesModified": ["ruta/archivo.ts"],
  "harness": "bloque ARNÉS para modos plan/approval"
}
```

**Campo "harness" (modo plan/approval):**
En modo `plan` o `approval`, BEE incluye el bloque ARNÉS antes de ejecutar: stack detectado, hipótesis interpretada, decisiones con trade-offs, contratos TypeScript, subagentes a crear, archivos estimados y riesgos. Este bloque se muestra al usuario para confirmación.

**Herramientas:** acceso completo — lectura + escritura + git + build/test + shell.
En modo `plan`, las herramientas de escritura están deshabilitadas.

**Principios:**
- *Default to action*: para cualquier solicitud técnica, usa herramientas en lugar de responder de memoria
- *Parallel tool calls*: lanza múltiples herramientas en paralelo cuando no tienen dependencias
- *Minimal changes*: hace los cambios mínimos necesarios — nunca reescribe entero lo que puede parcharse

---

### 2. ProductManager

**Archivo:** `packages/code/src/workers/product-manager.worker.ts`
**Rol en el pipeline:** Nivel 0 — siempre primero, antes de Architecture.

No hay arquitectura posible sin saber qué se va a construir. ProductManager corre **siempre** cuando BEE clasifica la acción como `architecture`, sin excepción. Su PRD es la entrada que Architecture necesita para diseñar con criterios verificables. **No escribe código de implementación.**

**Qué produce — PRD estructurado:**

| Sección | Contenido |
|---------|-----------|
| **Objetivo de negocio** | Qué problema resuelve para el usuario final (una oración) |
| **Historias de usuario** | Máximo 5, formato "Como [rol], quiero [acción] para [beneficio]" |
| **Criterios de aceptación** | Lista binaria (cumple/no cumple). QAEngineer los usa para escribir tests |
| **Constraints técnicos** | Dependencias, performance, compatibilidad, decisiones ya tomadas |
| **Fuera del alcance** | Qué NO incluye esta versión — previene scope creep |

**Flujo:** lee el narrativo + código existente → escribe el PRD en el blackboard con `write_decision` → Architecture lo usa como punto de partida → QAEngineer usa los criterios de aceptación.

**No se activa para:** bugs, refactors, optimizaciones, o cuando el PRD ya existe en el blackboard.

**Herramientas:** `fs_read`, `fs_list`, `fs_glob`, `code_search`, `read_narrative`, `write_decision`, `append_narrative`.

---

### 3. Architecture — Diseñador de Sistemas

**Archivo:** `packages/code/src/workers/architecture.worker.ts`
**Rol en el pipeline:** Nivel 1, siempre después de ProductManager.

Solo diseña — **nunca escribe código de implementación**. Lee el PRD que ProductManager dejó en el blackboard, los ADRs activos de sesiones anteriores, y la `agent_memory` de tipo `pattern` y `contract`. Produce el plan completo que todos los demás coordinadores seguirán.

**Qué produce (JSON estructurado):**

```json
{
  "adr": {
    "title": "...",
    "context": "problema a resolver",
    "options": "opciones evaluadas con trade-offs",
    "decision": "decisión tomada con justificación",
    "consequences": "consecuencias positivas y negativas"
  },
  "phases": [
    {
      "name": "implementar API de autenticación",
      "coordinator": "backend",
      "description": "...",
      "dependsOn": []
    }
  ],
  "risks": [{ "severity": "HIGH", "description": "..." }],
  "interfaces": "interfaces TypeScript de contratos entre módulos"
}
```

**Activación condicional de coordinadores por tipo de proyecto:**

| Tipo de proyecto | Coordinadores nivel 2 |
|-----------------|----------------------|
| Web frontend puro | `[frontend]` |
| Fullstack web | `[backend, frontend]` en paralelo |
| Mobile | `[frontend, backend]` en paralelo (frontend cubre web y mobile) |
| ML/IA | `[data_scientist, backend]` en paralelo |
| Fullstack ML | `[data_scientist, backend, frontend]` en paralelo |

`security`, `test` y `devops` **siempre** van después de los engineers, con `dependsOn` explícitos. `verifier` va después de `devops`, y `reviewer` después de `verifier` (necesita su evidencia antes del veredicto).

**Sub-agentes disponibles (en paralelo):**
- `diagram-agent` — genera diagramas Mermaid de la arquitectura propuesta
- `interface-agent` — genera interfaces TypeScript de contratos entre módulos
- `dependency-analyzer` — analiza el árbol de imports y detecta ciclos

**Herramientas:** `fs_read`, `fs_list`, `fs_exists`, `fs_glob`, `code_search`, `parse_ast`, `read_narrative`, `write_decision`, `check_types`.

**Regla clave:** si ya existe una decisión similar en el narrativo, no la contradice sin justificación explícita.

---

### 4. BackendEngineer

**Archivo:** `packages/code/src/workers/backend.worker.ts`
**Rol en el pipeline:** Nivel 2, en paralelo con Frontend/DataScientist.

Implementa APIs, lógica de negocio y acceso a datos en **TypeScript para Bun runtime**. Lee el ADR y los contratos de interfaces del blackboard antes de escribir una línea de código.

**Absorbe el rol de DBA** (fusionado): el schema de datos es parte del contrato de backend, no un dominio aparte — separarlo creaba una costura de escritor sin dividir trabajo real del LLM (el schema y las queries que lo consumen dependen fuertemente entre sí). El sub-agente `db-agent` sigue existiendo como especialización de diseño de datos.

**Flujo de trabajo:**
1. Lee el plan de Architecture del blackboard
2. Diseña el modelo de datos: colecciones HiveDB, índices, migraciones idempotentes (bootstrap sin asumir datos previos)
3. Implementa — verifica con `fs_read` antes de escribir cualquier archivo
4. Al terminar: escribe en el blackboard (`write_decision`, scope='schema') el modelo de datos y los endpoints implementados con sus contratos exactos

**Coordinación:** Los endpoints y el modelo de datos escritos en el blackboard son consumidos por Frontend y DataScientist. El CodeReviewer cruza esos contratos antes del veredicto final (responsabilidad absorbida de IntegrationAgent).

**Sub-agentes disponibles (pueden correr en paralelo):**
- `api-agent` — diseña e implementa endpoints HTTP (Bun.serve, Zod, rate limiting)
- `db-agent` — diseña el modelo de datos: colecciones HiveDB, índices, migraciones idempotentes
- `integration-agent` — integraciones con servicios externos (fetch nativo, retry, backoff)

**Herramientas:** `fs_read/write/edit/delete`, `fs_list/exists/glob`, `git_status/diff/commit/branch`, `code_search`, `code_build/test/lint`, `parse_ast`, `check_types`, `run_script`, `read_narrative`, `append_narrative`, `write_decision`, `shell_executor`.

**Reglas de seguridad:** credenciales siempre vía `Bun.secrets`, nunca hardcodeadas. Errores async con stack traces completos (Bun 1.3+).

---

### 5. FrontendEngineer

**Archivo:** `packages/code/src/workers/frontend.worker.ts`
**Rol en el pipeline:** Nivel 2, en paralelo con Backend/DataScientist.

Implementa UI de cliente — **web y mobile**. Determina el modo al iniciar (según el plan de Architecture o el stack existente en el repo) y opera con dos ciclos de verificación distintos.

**Absorbe el rol de MobileEngineer** (fusionado): es el mismo trabajo de UI de cliente contra un único contrato de API — separarlo en dos coordinadores generaba una costura de escritor sobre el mismo contrato sin dividir trabajo real del LLM, y ambos rara vez están activos a la vez.

**Modo web** — **ningún componente se marca completo sin screenshot de confirmación**:
1. Lee el contrato de API del Backend del narrativo
2. Spawna `component-agent` para implementar el componente
3. Usa `browser_screenshot` para verificar visualmente (screenshot + errores de consola)
4. Si hay errores de consola → corrección → vuelve al paso 2
5. Solo completa cuando hay screenshot limpio sin errores de consola

**Modo mobile** (React Native, Expo, iOS/SwiftUI, Android/Jetpack Compose) — no hay verificación visual automática, el ciclo de confirmación es build+test:
1. Lee el contrato de API del Backend del narrativo
2. Implementa el componente/pantalla con el stack del plan
3. Usa `code_build` para verificar que compila; si falla, corrige antes de continuar
4. Usa `code_test` para los tests mobile que existan

Principios mobile: `FlatList` en vez de `ScrollView+map` para listas largas, `React.memo`/`useCallback` para evitar re-renders, no bloquear el JS thread, cache local para estado offline (AsyncStorage, MMKV, HiveDB), y manejar siempre los 4 estados (`loading`, `error`, `empty`, `data`).

**Si un endpoint que necesita aún no está definido en el blackboard (ambos modos):** escribe la pregunta dirigida a Backend y continúa implementando las partes independientes.

**Al terminar:** escribe en el narrativo qué componentes creó y qué endpoints consume — el CodeReviewer lo usa para validar consistencia de contratos.

**Sub-agentes disponibles:**
- `component-agent` — implementa componentes UI (React, Vue, Svelte, Web Components, React Native)
- `style-agent` — tokens de diseño, CSS, Tailwind config (WCAG AA, mobile-first) — modo web
- `ui-debug-agent` — verifica visualmente via Bun.WebView a 1280×720 y 375×667 (mobile) — modo web

**Herramientas:** `fs_read/write/edit/delete`, `fs_list/exists/glob`, `git_status/diff/commit`, `code_search`, `code_build/test/lint`, `parse_ast`, `check_types`, `run_script`, `read_narrative`, `append_narrative`, `shell_executor`.

**Regla (modo web):** los errores de consola son blockers — no se ignoran.

---

### 6. DataScientist

**Archivo:** `packages/code/src/workers/data-scientist.worker.ts`
**Rol en el pipeline:** Nivel 2, en paralelo con Backend/Frontend.

Implementa modelos ML, pipelines de datos, agentes de IA y análisis estadístico. **Dominio distinto al BackendEngineer** — PyTorch, scikit-learn, transformers, pipelines de entrenamiento, evaluación de modelos y MLOps.

**Tipos de tarea:**

| Tipo | Qué hace |
|------|----------|
| **Modelo ML** | training → evaluation → export (joblib, ONNX, safetensors) |
| **Pipeline de datos** | ETL idempotente con validación de schema en cada paso |
| **Agente de IA** | RAG (chunking → embeddings → retrieval → generation) o agent con herramientas tipadas |
| **Análisis** | estadísticas descriptivas, visualizaciones, reportes con métricas concretas |

**Coordinación con Backend:** escribe el contrato del endpoint de predicciones ANTES de que el backend lo implemente:
```
DS_CONTRACT: POST /predict recibe { input: InputType } y retorna { result: ResultType, confidence: number }
```

**Reglas métricas:** reporta números concretos — no "mejoró el modelo" sino "F1 subió de 0.72 a 0.84 en val set".

**Herramientas:** `fs_read/write/edit`, `fs_list/exists/glob`, `code_search`, `parse_ast`, `run_script`, `read_narrative`, `append_narrative`, `shell_executor`.

---

### 7. SecurityAuditor

**Archivo:** `packages/code/src/workers/security.worker.ts`
**Rol en el pipeline:** Nivel 2 (transversal, en paralelo con engineers) + Nivel 3 (dedicado).

Revisa código ya escrito. **No implementa, no modifica código.** Opera en dos modos simultáneos:

- **Transversal (nivel 2):** corre en paralelo con Backend/Frontend/DataScientist. Detecta hallazgos CRITICAL y escribe constraints en el blackboard antes de que los workers afectados continúen.
- **Dedicado (nivel 3):** análisis completo del código producido por todos los engineers.

**Categorías auditadas siempre:**
- Inyecciones: SQL, command injection, path traversal
- Secrets hardcodeados o expuestos en logs
- Autenticación y autorización débil
- Dependencias vulnerables (lee `bun.lock`)
- XSS y validación de inputs
- Exposición de datos en respuestas de API

**Formato de hallazgo:**
```
CRITICAL · src/auth/login.ts:47
SQL concatenado con input del usuario — SQL injection posible
Fix: db.query("SELECT * FROM users WHERE email = ?", [email])
```

**Un hallazgo CRITICAL pausa la tarea completa hasta que el usuario apruebe.**

**Sub-agentes disponibles (en paralelo):**
- `sast-agent` — análisis estático de vulnerabilidades (SQL injection, XSS, CSRF)
- `dependency-audit-agent` — audita `bun.lock` y `package.json` por CVEs
- `secrets-scan-agent` — detecta secrets hardcodeados (nunca imprime el valor completo)

**Herramientas:** `fs_read`, `fs_list`, `fs_exists`, `fs_glob`, `code_search`, `parse_ast`, `check_dependencies`, `read_narrative`. **Solo lectura — sin herramientas de escritura.**

---

### 8. QAEngineer (Test)

**Archivo:** `packages/code/src/workers/test.worker.ts`
**Rol en el pipeline:** Nivel 3, en paralelo con Security dedicado.

Su trabajo **no termina hasta que los tests pasen o hasta 3 ciclos de retry**. Lee los criterios de aceptación del PRD de ProductManager para escribir casos verificables. El Context Compiler le inyecta `forensic_lessons` de sesiones anteriores para evitar repetir casos que ya causaron problemas.

**Ciclo de trabajo:**
1. Lee el código implementado (con el protocolo de lectura por tamaño)
2. Spawna los sub-agentes de testing según corresponda
3. Ejecuta tests con `run_tests` o `shell_executor`
4. Si falla: analiza el async stack trace completo
5. Decide: ¿bug en el test o bug en el código?
   - Bug en test → lo corrige, vuelve al paso 3
   - Bug en código → reporta al CoordinatorManager con análisis completo
6. Completa cuando cobertura ≥ 80% o después de 3 ciclos

**Flag siempre usado:** `--isolate` (entorno limpio por test)

**Sub-agentes disponibles (en paralelo cuando hay UI):**
- `unit-test-agent` — tests unitarios con `bun:test --isolate`, Arrange-Act-Assert, mocks
- `integration-test-agent` — flujos completos request→DB→response, sin mocks para servicios internos
- `e2e-agent` — tests E2E con Bun.WebView, simula interacciones de usuario, máx. 30s por test

**Herramientas:** `fs_read/write/edit`, `fs_list/exists/glob`, `git_status`, `code_search`, `code_test/build`, `parse_ast`, `check_types`, `run_script`, `read_narrative`, `append_narrative`, `shell_executor`.

---

### 9. DevOpsEngineer

**Archivo:** `packages/code/src/workers/devops.worker.ts`
**Rol en el pipeline:** Nivel 4, después de QA y Security.

Solo actúa cuando el código está aprobado por Security y Test. Lee el blackboard para entender qué cambios hicieron los otros workers y actualiza la infraestructura para soportarlos.

**Qué produce:**
- Dockerfile multi-stage optimizado (builder → runtime, imágenes fijas, tamaño objetivo < 200MB)
- GitHub Actions workflow con `bun:test --parallel --shard`
- Documentación de variables de entorno (nombres, nunca valores)
- README con instrucciones de deployment
- Changelog entry en formato Conventional Commits

**Paso final obligatorio:** crea un Pull Request con `git_create_pr`. El título en Conventional Commits, el body incluye el narrativo completo de la tarea.

**Sub-agentes disponibles:**
- `docker-agent` — Dockerfile multi-stage + .dockerignore (layer caching optimizado)
- `ci-agent` — GitHub Actions workflows (oven-sh/setup-bun@v2, jobs paralelos, secrets)
- `docs-agent` — README + CHANGELOG + docs/ con ejemplos funcionales

**Herramientas:** `fs_read/write/edit`, `fs_list/exists/glob`, `git_status/diff/commit/branch`, `git_create_pr`, `git_rollback`, `code_build/test/lint`, `read_narrative`, `append_narrative`, `shell_executor`.

**Regla de seguridad:** ninguna key o secret en archivos de CI — siempre vía GitHub Secrets.

---

### 10. Verifier

**Archivo:** `packages/code/src/workers/verifier.worker.ts`
**Rol en el pipeline:** Nivel 5, después de DevOps y antes de CodeReviewer.

Coordinador nuevo (no existía en el roster de 13). Su única responsabilidad es **reproducir, de forma independiente, los criterios de aceptación del PRD** contra el sistema real — no confía en que QA escribió los tests correctos ni en que el código "parece" correcto. **Nunca modifica código.**

**Por qué existe:** el hueco de verificación #1 en un enjambre multiagente es que QA puede escribir tests que pasan afirmando lo incorrecto, y el Reviewer lee código y diseño sin necesariamente ejecutar el sistema. Verifier es el chequeo que no confía en el reporte de nadie — toma cada criterio del PRD como una afirmación a probar, no como un hecho.

**Protocolo de trabajo:**
1. Lee el PRD de ProductManager en el blackboard y extrae los criterios de aceptación (binarios: cumple/no cumple)
2. Para cada criterio: identifica cómo reproducirlo de forma determinística — levantar el build/servidor, ejecutar el flujo real — y lo ejecuta
3. Prioriza siempre evidencia determinística (`code_test`, `code_build`, `shell_executor` con el comando exacto) sobre juicio propio
4. Si un criterio no es reproducible en el entorno, lo dice explícitamente — "no reproducible" no es lo mismo que "cumple"
5. Registra cada resultado en el blackboard (`write_decision`, scope='acceptance_verification')

**Output:** lista completa de criterios del PRD con veredicto individual (cumple / no cumple / no reproducible) y evidencia concreta. El CodeReviewer lee este resultado antes de emitir su veredicto final.

**Herramientas:** `fs_read`, `fs_list/exists/glob`, `code_search`, `parse_ast`, `code_test`, `code_build`, `shell_executor`, `run_script`, `read_narrative`, `write_decision`. **No modifica código.**

---

### 11. CodeReviewer — Gate de Calidad Final

**Archivo:** `packages/code/src/workers/reviewer.worker.ts`
**Rol en el pipeline:** Nivel 6, último antes de cerrar la tarea.

Siempre usa el **modelo de mayor capacidad disponible**, independientemente del modelo configurado para los otros workers. El Context Compiler le inyecta **toda** la `agent_memory` del proyecto — llega con el historial completo de lo que funcionó y lo que no. **Nunca modifica código.**

**Absorbe el rol de Integration** (fusionado): además del gate de calidad, cruza contratos entre módulos — endpoints (backend) vs consumo (frontend), modelo de datos vs queries, tipos exportados vs importados, cobertura de tests vs código implementado. La validación read-only de contratos y el review de contexto limpio son el mismo patrón de "quien juzga, no quien actúa" — separarlos en dos coordinadores no dividía trabajo real.

**Proceso de revisión:**
1. `read_narrative` → contexto completo de la sesión
2. `git_diff` → qué cambió exactamente
3. Lectura de archivos críticos → implementación vs diseño
4. Corre `check_types`/`code_test` él mismo — no asume que "pasaron" porque otro worker lo dijo
5. Cruza hallazgos de Security con el código real
6. **Cruce de contratos entre módulos** (responsabilidad absorbida de IntegrationAgent): endpoints↔consumo, modelo de datos↔queries, tipos↔imports, cobertura de tests↔código
7. Verifica que los tests cubran los casos de borde identificados
8. Emite el veredicto invocando la tool **`submit_review_verdict`** — nunca texto libre

**Criterios de rechazo:**
- Hallazgo de Security con severidad CRITICAL sin fix confirmado
- Incompatibilidad CRÍTICA de contratos entre módulos no resuelta (paso 6)
- Código implementado que contradice el ADR sin justificación
- Tests fallidos sin resolución documentada
- Funciones críticas en producción sin ningún test
- **Un test debilitado o eliminado para poder aprobar** — rechazo automático, sin excepción. Un agente que relaja sus propios criterios de verificación no puede auto-certificarse.

**Veredicto — `submit_review_verdict` (tool estructurada, no texto libre):**

```
verdict: aprobado | aprobado_con_observaciones | rechazado
criteria: [{ description, met: boolean, evidence }]   — uno por criterio del PRD, cruzado con evidencia real
categories: [{ name, status: ok|warning|blocking, detail }]
reasons: string   — obligatorio si rechazado, con archivo:línea
```

Prioridad de evidencia: determinística (`code_test`/`check_types`) > visual > juicio propio. "El código no está bien" no es razón válida. "backend/auth.ts:47 usa SQL concatenado (hallazgo CRITICAL de Security)" sí lo es. Si el modelo no invoca la tool (p.ej. un modelo más débil), hay un fallback de string-matching sobre el texto libre — pero el camino primario y confiable es el veredicto estructurado.

**Si rechaza:** BEE relanza los workers afectados con los constraints del rechazo.

**Herramientas:** `fs_read`, `fs_list/exists/glob`, `code_search`, `parse_ast`, `git_status/diff/log`, `read_narrative`, `write_decision`, `check_types`, `code_test`. **Sin herramientas de escritura de código.**

---

## Workers on-demand

Estos dos workers no forman parte del pipeline de ejecución secuencial. Se activan por condiciones específicas.

---

### Librarian

**Archivo:** `packages/code/src/workers/librarian.worker.ts`
**Activación:** Solo cuando CodeReviewer emitió `APROBADO` o `APROBADO_CON_OBSERVACIONES`.

Destila el conocimiento de la sesión en memoria persistente (`agent_memory.db`) para sesiones futuras. **Destila — no transcribe.** Lee el narrativo completo y extrae solo lo accionable para sesiones futuras.

**Tipos de conocimiento que persiste:**

| Tipo | Ejemplo |
|------|---------|
| `pattern` | "Las queries en este proyecto usan prepared statements con db.query() de Bun HiveDB" |
| `antipattern` | "Agregar dependencias externas de caché viola el ADR-003 de este proyecto" |
| `contract` | "El endpoint /auth/refresh recibe { refreshToken: string } y devuelve { accessToken, refreshToken }" |
| `convention` | "Los campos en respuestas de API usan camelCase, no snake_case" |
| `forensic_lesson` | "Backend falla en loops cuando modifica queries sin leer el modelo de datos que escribió antes en el blackboard" |

**Reglas de destilación:**
- Un registro = un hecho accionable (no narrativos largos)
- No incluye lo que ya está obvio en el código — solo lo no-obvio
- No repite lo que ya está en los ADRs del proyecto

**Depreciación:** si `refuted_count > confirmed_count + 2`, el registro se marca como `deprecated`. Nunca se borra — se depreca con trazabilidad completa.

**Herramientas:** `fs_read`, `fs_list`, `fs_glob`, `read_narrative`, `write_memory`. **Sin herramientas de escritura de código.**

---

### ForensicAgent

**Archivo:** `packages/code/src/workers/forensic.worker.ts`
**Activación:** dos condiciones — (1) un worker alcanza su límite de iteraciones sin completar, o (2) una tarea agota sus reintentos automáticos (`FailureRecoveryScheduler`, con backoff exponencial) sin resolverse. En el caso (2) el análisis forense se adjunta a la escalación a revisión humana, en vez de escalar solo con el mensaje de error crudo.

El CoordinatorManager **nunca relanza** un worker que falló por límite sin esperar el análisis del ForensicAgent. **Nunca modifica código.**

**Análisis en 3 partes obligatorias:**

**Parte 1 — Qué intentó el worker:**
Cada intento en orden cronológico: qué herramienta llamó, qué intentó modificar, qué error recibió. Resumido, no transcrito.

**Parte 2 — Por qué falló:**
Causa raíz clasificada en:
- `error_de_implementacion` — el worker tomó el enfoque equivocado
- `conflicto_con_constraint` — el worker ignoró un constraint activo en el blackboard
- `limitacion_del_entorno` — las herramientas o permisos no permiten lo que intentó
- `problema_de_especificacion` — la tarea es ambigua o contradictoria

**Parte 3 — Recomendación (exactamente una de tres):**

| Recomendación | Cuándo | Efecto |
|--------------|--------|--------|
| `relanzar_con_constraint: {constraint}` | El problema es corregible | El manager escribe el constraint y relanza el worker |
| `reasignar_a: {worker}` | La tarea no corresponde a este worker | Otro coordinador toma la tarea |
| `escalar_al_humano: {opciones}` | El problema requiere decisión humana | Pausa, espera input del operador |

**Herramientas:** `fs_read`, `fs_list`, `fs_glob`, `code_search`, `parse_ast`, `read_narrative`. **Solo lectura.**

---

## Los 18 sub-agentes

Los sub-agentes son especializaciones dentro del dominio de un coordinador. Cada coordinador puede spawnarlos en paralelo para dividir el trabajo. Los sub-agentes **no tienen acceso a herramientas del workspace** salvo lo mínimo indicado — son esencialmente llamadas LLM focalizadas con un output específico.

BEE puede delegar a **cualquier** sub-agente de cualquier coordinador.

### Sub-agentes de Architecture

| Sub-agente | Qué produce |
|-----------|------------|
| `diagram-agent` | Diagramas Mermaid (graph TD, sequenceDiagram, classDiagram). Sintaxis v10+, subgraphs para microservicios |
| `interface-agent` | Interfaces TypeScript strict (no `any` implícito), con JSDoc para propiedades no obvias, compilables con `bun tsc --noEmit` |
| `dependency-analyzer` | Reporte de ciclos de importación: CRITICAL (ciclo directo), HIGH (ciclo indirecto), MEDIUM (dependencia innecesaria) |

### Sub-agentes de Backend

| Sub-agente | Qué produce |
|-----------|------------|
| `api-agent` | Endpoints HTTP con Bun.serve o Elysia, validación Zod, rate limiting, JSDoc, tests básicos |
| `db-agent` | Schema + migraciones versionadas (HiveDB WAL / PostgreSQL / drizzle-orm), seed data para tests |
| `integration-agent` | Clientes tipados para servicios externos con retry exponencial, cache, rate limit handling |

### Sub-agentes de Frontend

| Sub-agente | Qué produce |
|-----------|------------|
| `component-agent` | Componentes UI (React/Vue/Svelte/vanilla), hooks propios, manejo de loading/error, stories para Storybook |
| `style-agent` | CSS, Tailwind config, tokens de diseño (WCAG AA, dark mode, mobile-first) |
| `ui-debug-agent` | Screenshot a 1280×720 y 375×667 + reporte de errores de consola. Un CRITICAL si hay errores |

### Sub-agentes de Security

| Sub-agente | Qué produce |
|-----------|------------|
| `sast-agent` | Reporte CRITICAL/HIGH/MEDIUM/LOW por archivo:línea con fix sugerido en diff format |
| `dependency-audit-agent` | Reporte de CVEs, dependencias obsoletas (>1 año), licencias incompatibles |
| `secrets-scan-agent` | Lista de secrets encontrados con tipo, archivo, línea y preview parcial (nunca el valor completo) |

### Sub-agentes de Test

| Sub-agente | Qué produce |
|-----------|------------|
| `unit-test-agent` | Tests unitarios con `bun:test --isolate`, Arrange-Act-Assert, mocks para dependencias, cobertura ≥ 80% |
| `integration-test-agent` | Tests contra servidor real (Bun.serve), limpieza de estado entre tests, verificación de headers y response shape |
| `e2e-agent` | Tests E2E con Bun.WebView, simula interacciones de usuario, screenshots comparativos, máx. 30s por test |

### Sub-agentes de DevOps

| Sub-agente | Qué produce |
|-----------|------------|
| `docker-agent` | Dockerfile multi-stage + .dockerignore (layer caching optimizado, tamaño objetivo < 200MB) |
| `ci-agent` | GitHub Actions workflows (setup-bun@v2, jobs paralelos, matrix strategy, artifacts) |
| `docs-agent` | README + CHANGELOG (Keep a Changelog + Conventional Commits) + docs/ con OpenAPI si hay API |

---

## Tabla de herramientas por coordinador

| Tool | BEE | Arch | PM | Back | Front | DS | Sec | Test | DevOps | Ver | Rev | Lib | Forensic |
|------|:---:|:----:|:--:|:----:|:-----:|:--:|:---:|:----:|:------:|:---:|:---:|:---:|:--------:|
| `fs_read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `fs_write` | ✓ | — | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | — | — |
| `fs_edit` | ✓ | — | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | — | — | — |
| `fs_delete` | ✓ | — | — | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `code_search` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | ✓ |
| `parse_ast` | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | ✓ |
| `git_*` | ✓ | — | — | partial | partial | — | — | partial | full | — | partial | — | — |
| `git_create_pr` | — | — | — | — | — | — | — | — | ✓ | — | — | — | — |
| `code_build` | ✓ | — | — | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | — | — | — |
| `code_test` | ✓ | — | — | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | ✓ | — | — |
| `check_types` | ✓ | ✓ | — | ✓ | ✓ | — | — | ✓ | — | — | ✓ | — | — |
| `shell_executor` | ✓ | — | — | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | — | — |
| `run_script` | ✓ | — | — | ✓ | ✓ | ✓ | — | ✓ | — | ✓ | — | — | — |
| `write_decision` | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | ✓ | ✓ | — | — |
| `write_memory` | — | — | — | — | — | — | — | — | — | — | — | ✓ | — |
| `check_dependencies` | — | — | — | — | — | — | ✓ | — | — | — | — | — | — |

**En modo `plan`:** las herramientas de escritura (`fs_write`, `fs_edit`, `fs_delete`, `git_commit`, `git_branch`, `git_create_pr`, `git_rollback`, `append_narrative`, `write_decision`) están deshabilitadas para todos los coordinadores.

---

## Flujo de conocimiento entre workers

```
ProductManager → ADR blackboard (PRD, criterios de aceptación)
                    ↓
Architecture → Lee PRD + escribe ADR + contratos TypeScript
                    ↓
Backend → Lee contratos + diseña modelo de datos + escribe endpoints y schema en blackboard
                                                                          ┐
Frontend (web+mobile) → Lee contratos de backend + implementa cliente    │ Promise.all()
DS      → Lee plan + escribe DS_CONTRACT para backend                   │
                    ↓                                                    ┘
Security → Lee todo el código escrito
Test    → Lee código + criterios PRD (del ProductManager)
                    ↓
DevOps  → Lee blackboard completo + git history
                    ↓
Verifier → Lee criterios de aceptación del PRD + los reproduce contra el sistema real
           (independiente de lo que QA/Backend/Frontend reportaron)
                    ↓
Reviewer → Lee TODA la sesión + git diff + evidencia de Verifier + ejecuta check_types/code_test
           + cruza contratos entre módulos (endpoints↔consumo, schema↔queries, tipos↔imports)
                    ↓
         ┌─────────┴───────────┐
         APROBADO           RECHAZADO
              ↓                  ↓
         Librarian          Workers relanzados
         (destila →         con constraints del
          agentMemory)      CodeReviewer
```

El flujo de conocimiento es unidireccional: cada worker lee lo que dejaron los anteriores en el blackboard y añade su propio aporte. Verifier y Reviewer son los que cruzan información de múltiples fuentes — Verifier contra el sistema real, Reviewer contra los contratos declarados entre módulos.
