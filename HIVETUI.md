# Aprende Rust construyendo hiveTui
**Para:** Johpaz  
**Enfoque:** aprender Rust real en un proyecto tuyo  
**Herramienta:** Claude Code como tutor, no como escritor  
**Regla de oro:** si Claude Code escribe código sin que lo entiendas, pediste mal

---

## Antes de empezar — cómo usar Claude Code para aprender

La diferencia entre aprender y que te lo hagan:

**Mal prompt:**
> "Implementa el InputState con cursor UTF-8"

**Buen prompt:**
> "Quiero implementar un struct InputState que tenga un campo buffer de tipo String
> y un campo cursor de tipo usize. Antes de escribir código, explícame por qué
> en Rust usamos usize para un índice y no int como en TypeScript"

La regla: **primero el concepto, luego el código, luego tú lo escribes**.
Claude Code te explica, tú escribes, Claude Code revisa.

---

## Mapa de lo que vas a construir

```
Fase 0 — Cargo y hello world          → aprendes: toolchain, módulos, Result
Fase 1 — Estado de la app             → aprendes: structs, enums, ownership
Fase 2 — Input con cursor correcto    → aprendes: String vs &str, UTF-8, métodos
Fase 3 — Renderer y layout            → aprendes: referencias mutables, lifetimes básicos
Fase 4 — IPC con Bun                  → aprendes: tokio, async/await, mpsc channels
Fase 5 — Event loop completo          → aprendes: tokio::select!, pattern matching
Fase 6 — Comandos y pulido            → aprendes: enums con datos, match exhaustivo
```

Cada fase tiene:
- El concepto Rust que vas a aprender
- Qué construyes exactamente
- Preguntas que le haces a Claude Code antes de codear
- Cómo verificar que entendiste

---

## FASE 0 — Cargo y el entorno

### Qué construyes
Un proyecto Rust que compila, muestra el terminal en negro y sale limpio con Ctrl+C.
Nada más. Si logras eso, el entorno funciona.

### Concepto Rust: el sistema de módulos

En TypeScript tienes `import/export`. En Rust tienes `mod` y `pub`.
La diferencia clave: en Rust los módulos son el sistema de privacidad,
no solo de organización. Todo es privado por defecto.

**Pregúntale a Claude Code antes de tocar el teclado:**
- "¿Qué hace exactamente `mod app;` en main.rs? ¿Cómo sabe Rust dónde está el archivo?"
- "¿Por qué Rust tiene `pub` a nivel de struct Y a nivel de campo? ¿No es redundante?"
- "Explícame `color_eyre::install()` — ¿qué problema resuelve y por qué es lo primero que va en main?"

### Concepto Rust: Result y el operador ?

Venís de TypeScript donde los errores son excepciones que se lanzan.
En Rust los errores son valores que se retornan. `Result<T, E>` es
o un valor exitoso `Ok(T)` o un error `Err(E)`.

El operador `?` es azúcar sintáctica para "si esto falla, retorna el error inmediatamente".
Es el `try/catch` de Rust pero sin exceptions.

**Pregúntale a Claude Code:**
- "¿Por qué `main` retorna `Result<()>` en Rust moderno? ¿Qué pasaba antes?"
- "Muéstrame qué hace exactamente el operador `?` — expándelo sin azúcar sintáctica"
- "¿Qué diferencia hay entre `unwrap()`, `expect()` y `?` — cuándo uso cada uno?"

### Estructura de archivos de esta fase

```
packages/tui/
├── Cargo.toml     ← tú lo escribes a partir del TDD
└── src/
    ├── main.rs    ← punto de entrada
    └── app.rs     ← función run() — setup y teardown del terminal
```

### Cómo verificar que entendiste
Antes de pasar a Fase 1 debes poder responder sin mirar:
- ¿Qué hace `#[tokio::main]`?
- ¿Por qué el panic hook restaura el terminal antes de hacer panic?
- ¿Qué es `color_eyre` y por qué lo usamos en vez de `anyhow`?

---

## FASE 1 — Estado de la aplicación

### Qué construyes
Todos los structs de estado: `AppState`, `SessionState`, `InputState`,
`HistoryState`, `CheckpointState`, `WorkerState`, `DirtyFlags`, etc.
Sin lógica todavía — solo los tipos. El programa sigue mostrando negro.

### Concepto Rust: ownership

Este es el concepto más importante de Rust y el más diferente a TypeScript.

En TypeScript, dos variables pueden apuntar al mismo objeto:
```typescript
const a = { name: "bee" }
const b = a  // b y a apuntan al mismo objeto
```

En Rust eso no existe para tipos que no implementen `Copy`.
Cuando asignas, el valor se **mueve** — el dueño anterior ya no puede usarlo.

**Pregúntale a Claude Code:**
- "Explícame ownership con un ejemplo de String en Rust — muéstrame qué error da el compilador si intento usar una variable después de moverla"
- "¿Por qué String no implementa Copy pero i32 sí? ¿Cuál es la regla?"
- "En AppState tengo un campo `input: InputState` y otro `session: SessionState`. ¿Puedo modificarlos al mismo tiempo? ¿Qué dice el borrow checker?"

### Concepto Rust: structs y sus métodos

En TypeScript tienes clases. En Rust tienes `struct` + `impl`.
La separación es intencional: los datos y el comportamiento son conceptos distintos.

**Pregúntale a Claude Code:**
- "¿Qué diferencia hay entre `impl SessionState { fn foo(&self) }` y `fn foo(&mut self)`? ¿Por qué es importante el `&mut`?"
- "¿Qué es `#[derive(Default)]` y qué genera exactamente? ¿Puedo implementarlo yo a mano?"
- "¿Cuándo uso `Default` y cuándo creo un constructor `new()`?"

### Concepto Rust: enums

Los enums de Rust son completamente distintos a los de TypeScript.
En Rust, cada variante puede tener datos diferentes.

Tu `ReplMode` es un enum simple. Pero `ModalState` es un enum con datos:
una variante `Config` tiene campos, otra `Info` tiene otros campos, otra `None` no tiene nada.
Esto reemplaza el patrón de "union types" de TypeScript pero con garantías del compilador.

**Pregúntale a Claude Code:**
- "Muéstrame la diferencia entre un enum de TypeScript y un enum de Rust con datos — ¿por qué se llaman 'algebraic data types'?"
- "¿Qué es pattern matching y por qué el compilador me obliga a cubrir todos los casos?"
- "¿Cómo se compara `Option<T>` de Rust con `T | undefined` de TypeScript?"

### Estructura de archivos de esta fase

```
src/
├── main.rs
├── app.rs
└── state/
    ├── mod.rs         ← re-exporta todo con pub use
    ├── session.rs     ← SessionState + ReplMode
    ├── input.rs       ← InputState (sin lógica aún)
    ├── history.rs     ← HistoryState + HistoryEntry + Role
    ├── checkpoint.rs  ← CheckpointState + Checkpoint
    ├── workers.rs     ← WorkerState + Worker + WorkerStatus
    ├── filemap.rs     ← FileMapState + FileEntry + RiskLevel
    ├── thought.rs     ← ThoughtStreamState
    ├── conflicts.rs   ← ConflictState + AgentConflict
    ├── modal.rs       ← ModalState (enum con datos)
    ├── logs.rs        ← LogState + LogEntry
    ├── mascot.rs      ← MascotState
    └── dirty.rs       ← DirtyFlags
```

### Ejercicio de comprensión
Antes de pasar a Fase 2, escribe sin ayuda de Claude Code:
un struct `WorkerStatus` como enum con 4 variantes (Waiting, Running, Done, Failed)
y un método `emoji(&self) -> &'static str` que retorna el emoji correspondiente.
Si lo logras, entendiste enums y métodos.

---

## FASE 2 — Input con cursor correcto

### Qué construyes
La lógica completa del input: insertar caracteres, borrar, mover el cursor,
scroll horizontal. Es el fix del Bug 5 del TUI actual.

### Concepto Rust: String vs &str y el infierno del UTF-8

Este es el primer momento donde Rust te va a frustrar si vienes de TypeScript.

En TypeScript una string es una string. En Rust hay dos tipos:
- `String` → string con dueño, vive en el heap, se puede modificar
- `&str` → referencia a una string, puede apuntar a cualquier string

El problema del cursor: en TypeScript `string[3]` te da el 4to caracter.
En Rust `&str[3]` te da el 4to **byte** — que puede estar en medio de un emoji
de 4 bytes y causar un panic en runtime.

La solución correcta: trabajar con `char_indices()` que itera por **caracteres**
Unicode, no por bytes.

**Pregúntale a Claude Code antes de codear:**
- "¿Por qué indexar un String en Rust por posición de byte puede causar panic? Dame un ejemplo con un emoji"
- "Explícame char_indices() — ¿qué retorna exactamente y por qué es más seguro que indexar directamente?"
- "¿Qué diferencia hay entre `.len()` y `.chars().count()` en un String con emojis?"
- "¿Por qué `String::insert(byte_idx, char)` recibe un índice de bytes y no de caracteres?"

### Concepto Rust: métodos con &self vs &mut self

Cuando implementas `insert(&mut self, c: char)` estás diciendo:
"este método necesita modificar el struct". El compilador garantiza que
nadie más puede tener una referencia a `self` mientras este método corre.

Cuando implementas `scroll_offset(&self, width: usize) -> u16` estás diciendo:
"este método solo lee". Pueden existir múltiples referencias de lectura simultáneas.

**Pregúntale a Claude Code:**
- "¿Por qué Rust me deja tener múltiples `&T` pero solo un `&mut T`? ¿Qué problema evita eso?"
- "Si tengo `state.input.insert(c)` y `state.dirty.input = true` en la misma línea, ¿el borrow checker tiene algún problema? ¿Por qué sí o por qué no?"

### Qué métodos implementa InputState

Piensa en cada uno antes de codear — escribe en papel qué hace cada método:

- `insert(c: char)` → inserta en la posición del cursor, avanza el cursor
- `backspace()` → borra el caracter anterior al cursor, retrocede el cursor
- `delete_forward()` → borra el caracter en la posición del cursor
- `move_left()`, `move_right()` → mueven el cursor ±1 caracter
- `move_word_left()`, `move_word_right()` → saltan por palabras (Ctrl+←→)
- `move_home()`, `move_end()` → al inicio / al final del buffer
- `scroll_offset(width: usize) -> u16` → columnas a ocultar para que el cursor sea visible
- `submit() -> String` → retorna el buffer, lo limpia, guarda en historial
- `history_up()`, `history_down()` → navega el historial de inputs (↑↓)

### Cómo verificar que entendiste
Escribe un test unitario (sin Claude Code) que:
1. Crea un `InputState` vacío
2. Inserta "Hola 🐝 mundo"
3. Verifica que `cursor` es 12 (no 14 bytes)
4. Mueve el cursor al inicio
5. Verifica que `scroll_offset(10)` es 0

Si el test pasa sin ayuda, entendiste UTF-8 en Rust.

---

## FASE 3 — Renderer y widgets base

### Qué construyes
El layout visual: header, input con cursor, historial con scrollbar, mascota
en un solo lugar. Es el fix de los Bugs 3 y 4.

### Concepto Rust: referencias y lifetimes básicos

Cuando escribes `fn render(f: &mut Frame, state: &mut AppState)`
estás pasando referencias mutables. El compilador garantiza que estas
referencias son válidas durante toda la función.

Los lifetimes son la forma en que Rust razona sobre cuánto tiempo vive una referencia.
En la mayoría de casos no necesitas escribirlos explícitamente — el compilador los infiere.
Pero es importante entender qué significan cuando aparecen.

**Pregúntale a Claude Code:**
- "¿Por qué en ratatui los widgets usan lifetimes como `Paragraph<'a>`? ¿Qué están protegiendo?"
- "Si creo un `ListItem` dentro de un closure y lo uso fuera, ¿por qué el compilador se queja?"
- "Explícame `'static` — ¿qué significa que algo vive 'para siempre'?"

### Concepto Rust: el patrón de render con DirtyFlags

En el TUI anterior, cada keystroke redibuja todo — eso incluye renderizar
markdown costoso en cada tecla presionada. El patrón correcto:

Cada parte de la UI tiene un flag. Solo se redibuja si el flag está activo.
Un keystroke en el input activa `dirty.input = true` solamente.
El historial no se redibuja.

**Pregúntale a Claude Code:**
- "¿Por qué en Rust no puedo tener dos referencias mutables al mismo tiempo — por ejemplo a `state.input` y a `state.history`?"
- "¿Cómo resuelve ratatui el problema de que el renderer necesita acceso mutable al estado pero también a sí mismo?"

### El Bug 4 — mascota duplicada

La causa es simple: el widget de la mascota se renderizaba en dos lugares
distintos del código. La solución es una regla de diseño, no de código:
**existe una sola función que renderiza la mascota, llamada desde un solo lugar**.

Cuando vayas a implementar el `render_bottom_bar`, escribe un comentario
explícito: `// ÚNICA llamada a mascot::render en todo el proyecto`.
El compilador no puede enforcar esto — lo enforca el diseño.

### Estructura de archivos de esta fase

```
src/
├── renderer/
│   ├── mod.rs        ← render() principal + selección de layout
│   ├── plan.rs       ← Layout::Plan
│   ├── code.rs       ← Layout::Code
│   ├── review.rs     ← Layout::Review
│   ├── focus.rs      ← Layout::Focus (historial full screen)
│   └── dashboard.rs  ← Layout::Dashboard
└── widgets/
    ├── mod.rs
    ├── header.rs
    ├── input.rs      ← render con cursor correcto
    ├── history.rs    ← render con scrollbar
    ├── mascot.rs     ← ÚNICO punto de render
    ├── checkpoint_bar.rs
    ├── conflict_alert.rs
    └── workers_panel.rs
```

Los demás widgets (`thought_stream`, `diff_view`, `adr_viewer`, `modal`, `logs`)
se implementan como stubs vacíos en esta fase y se rellenan en fases posteriores.

### Cómo verificar que entendiste
Ejecuta `cargo run`. Debes ver:
- Header con texto (puede ser vacío/default)
- Un área central negra
- La mascota abajo a la izquierda — UNA SOLA VEZ
- El cursor parpadeando en el input
- `Ctrl+C` sale limpio y el terminal queda normal

---

## FASE 4 — IPC con Bun

### Qué construyes
La conexión Unix socket con el proceso Bun, la deserialización de mensajes
y los tres canales de prioridad (critical, normal, low).

### Concepto Rust: async/await y tokio

Vienes de Bun donde async/await existe nativamente. En Rust es similar
en sintaxis pero diferente en implementación — necesitas un *runtime* explícito.
`tokio` es ese runtime. `#[tokio::main]` convierte tu `main` síncrono en async.

La diferencia clave con TypeScript: en Rust un `Future` (el equivalente de Promise)
**no hace nada hasta que alguien lo espera (await)**. En TypeScript una Promise
empieza a ejecutarse cuando la creas.

**Pregúntale a Claude Code:**
- "¿Por qué en Rust necesito un runtime como tokio para async/await? ¿Por qué no está en la stdlib?"
- "Explícame la diferencia entre `tokio::spawn` y simplemente hacer `await` — ¿cuándo uso cada uno?"
- "¿Qué es un mpsc channel en Rust? Compáralo con un EventEmitter de Node"

### Concepto Rust: serde y tagged enums

La magia del protocolo IPC es `#[serde(tag = "type", rename_all = "snake_case")]`.
Esto le dice a serde que el campo `"type"` del JSON determina qué variante
del enum deserializar. Es el patrón discriminated union de TypeScript,
pero enforado por el compilador.

**Pregúntale a Claude Code:**
- "Explícame qué genera el macro `#[serde(tag = 'type')]` — ¿qué JSON produce y consume?"
- "¿Por qué los macros de Rust como `#[derive(Deserialize)]` son más poderosos que los decorators de TypeScript?"
- "¿Qué pasa si llega un JSON con un `type` desconocido? ¿Cómo manejo eso?"

### El patrón de los tres canales

El IPC no es un solo canal — son tres `mpsc::channel` separados por prioridad:
- **critical**: checkpoints, halt, conflictos, Init — nunca se puede perder
- **normal**: historial, workers, streams — flujo normal
- **low**: logs — puede dropear bajo presión de memoria

En el event loop, `tokio::select! biased` procesa critical antes que normal,
normal antes que low. El `biased` es importante — sin él, tokio elige
aleatoriamente qué rama ejecutar.

**Pregúntale a Claude Code:**
- "¿Qué hace exactamente `biased` en `tokio::select!`? ¿Qué problema resuelve?"
- "¿Por qué usar tres canales mpsc separados en vez de un solo canal con un campo de prioridad?"
- "¿Qué pasa si el receiver de un canal se dropea? ¿Y si el sender?"

### Sobre el demo mode

Si `HIVECODE_IPC` no existe, el TUI debe arrancar sin backend —
útil para desarrollar la UI sin tener Bun corriendo.
La implementación: crear los canales normalmente pero no conectar ningún socket.
Los canales quedan vacíos — el event loop corre pero nunca recibe mensajes de Bun.

### Cómo verificar que entendiste
- `cargo run` sin `HIVECODE_IPC` → arranca en demo mode, no crashea
- `HIVECODE_IPC=/tmp/noexiste.sock cargo run` → maneja el error limpiamente
- Entiende sin mirar el código por qué el IPC usa NDJSON en vez de JSON puro

---

## FASE 5 — Event loop completo

### Qué construyes
El `tokio::select!` final que multiplexa teclado + mensajes Bun + tick de animación,
y la función `apply_message` que aplica cada `BunMessage` al estado.

### Concepto Rust: pattern matching exhaustivo

El `match` de Rust no es un `switch` de TypeScript. Es exhaustivo:
el compilador verifica que cubriste todas las posibilidades.
Si agregas una nueva variante a `BunMessage`, el compilador te dice
exactamente dónde te falta manejarla.

Esto es fundamental para la corrección del TUI — si Bun empieza a enviar
un nuevo tipo de mensaje, el compilador te fuerza a manejarlo.

**Pregúntale a Claude Code:**
- "¿Qué es el 'if let' pattern en Rust y cuándo lo uso en vez de 'match'?"
- "Explícame los guards en match — `match x { Some(n) if n > 0 => ... }`"
- "¿Qué hace `..` en un pattern match de struct? `BunMessage::Init { mode, .. }`"

### Concepto Rust: el borrow checker en el event loop

El momento más confuso: tienes `state.history` y `state.dirty` y quieres
modificar ambos en el mismo bloque. El borrow checker puede quejarse.

La regla: solo puede existir **un** `&mut` a un valor al mismo tiempo.
Pero campos diferentes de un struct sí se pueden tomar prestados simultáneamente —
el compilador es suficientemente inteligente para eso desde Rust 2018 (NLL).

**Pregúntale a Claude Code:**
- "Muéstrame un ejemplo donde el borrow checker me bloquea aunque 'debería' funcionar — y cómo resolverlo sin unsafe"
- "¿Por qué puedo hacer `state.history.push(...)` y `state.dirty.history = true` en la misma función pero no `let a = &mut state.history; let b = &mut state.dirty; a.push(...); b.history = true;`?"

### La función apply_message

Es un `match` exhaustivo de todas las variantes de `BunMessage`.
Cada variante actualiza el estado correspondiente y marca los dirty flags correctos.

La disciplina es importante: `HistoryAppend` marca `dirty.history = true`.
`ReasoningChunk` marca `dirty.thought = true`. Un keystroke en el input
marca `dirty.input = true`. Nada más.

**Antes de codear, mapea en papel:**
cada variante de `BunMessage` → qué campos del estado modifica → qué dirty flags activa

Si haces ese mapeo antes de escribir código, el `apply_message` sale perfecto.

### Cómo verificar que entendiste
Ejecuta el TUI conectado a Bun real. Verifica:
- El header muestra provider/modelo/modo del Init
- `/provider set anthropic` actualiza el header inmediatamente (fix Bug 6)
- Un mensaje de Bun aparece en el historial
- Los workers se actualizan en el panel

---

## FASE 6 — Comandos slash y pulido

### Qué construyes
El parser de comandos `/` y los últimos widgets: thought stream, file map,
conflict alert, adr viewer. El TUI queda completo.

### Concepto Rust: enums con datos como estado de máquina

`ModalState` es un enum donde cada variante tiene datos distintos:
```
None              → no hay modal
Config { ... }    → modal de configuración con campos
Info { ... }      → modal informativo con contenido
```

Cuando haces `match state.modal { ModalState::Config { command, fields, .. } => ... }`
el compilador garantiza que `command` y `fields` solo existen cuando el modal
es realmente de tipo Config. No hay forma de acceder a `command` si el modal es `Info`.

Esto reemplaza el patrón de TypeScript con `type` discriminators pero con
garantías en tiempo de compilación.

**Pregúntale a Claude Code:**
- "¿Cómo se compara ModalState como enum con una interfaz discriminada de TypeScript? ¿Qué puedo hacer en Rust que no puedo en TypeScript?"
- "¿Qué es `if let ModalState::Config { command, .. } = &state.modal` — por qué el `&` antes del valor?"

### Tests unitarios — aprender a escribirlos en Rust

Rust tiene testing incorporado — no necesitas jest ni vitest.
Los tests van en el mismo archivo con `#[cfg(test)]` y `#[test]`.

Los tres tests más importantes para este proyecto:

**Test 1 — InputState con emoji:**
Inserta "Hola 🐝", verifica que el cursor está en posición 7 (no en bytes),
mueve al inicio, verifica scroll_offset.

**Test 2 — CheckpointState límite:**
Inserta 55 checkpoints, verifica que solo quedan 50 (los más recientes).

**Test 3 — SessionState.apply_update:**
Crea un SessionState, llama apply_update con nuevo provider,
verifica que dirty.header quedó en true.

**Pregúntale a Claude Code:**
- "¿Cómo funciona `#[cfg(test)]` — por qué los tests no se compilan en release?"
- "¿Qué es `assert_eq!` vs `assert!` — cuándo uso cada uno?"
- "¿Cómo testeo código async con tokio en Rust?"

### El cargo clippy — tu mejor profesor

Antes de cerrar cada fase, corre `cargo clippy -- -D warnings`.
Clippy es el linter de Rust y sus mensajes son los mejores para aprender
idiomas de Rust — te dice no solo qué está mal sino cómo se hace idiomático.

Por cada warning de clippy: no lo arregles automáticamente.
Pregúntale a Claude Code "¿por qué clippy dice esto y qué es la forma idiomática?"

---

## Tabla de conceptos Rust vs TypeScript

| TypeScript | Rust | Diferencia clave |
|-----------|------|-----------------|
| `class` | `struct` + `impl` | datos y comportamiento separados |
| `interface` | `trait` | los traits son más poderosos (pueden tener implementaciones default) |
| `type A = B \| C` | `enum` con variantes | el compilador verifica exhaustividad |
| `string` | `String` / `&str` | dueño vs referencia, UTF-8 por bytes |
| `Promise<T>` | `Future<T>` | los Futures son lazy — no corren hasta el await |
| `try/catch` | `Result<T,E>` + `?` | los errores son valores, no excepciones |
| `undefined` | `Option<T>` | `None` / `Some(T)` — sin null pointer exceptions |
| `const x = obj` | `let x = obj` | mover la propiedad, `obj` ya no es válido |
| `readonly` | `&T` | referencia inmutable — el compilador lo enforza |

---

## Señales de que vas bien

Después de cada fase deberías poder responder estas preguntas sin mirar:

**Después de Fase 0:**
¿Qué hace `?` en `setup_terminal()?`

**Después de Fase 1:**
¿Por qué `ModalState` es un enum y no un struct con campos opcionales?

**Después de Fase 2:**
¿Por qué `cursor` es un contador de chars y no de bytes?

**Después de Fase 3:**
¿Por qué la mascota solo se renderiza desde un lugar?

**Después de Fase 4:**
¿Por qué el IPC tiene tres canales separados y no uno con prioridad?

**Después de Fase 5:**
¿Por qué `tokio::select! biased` y no `tokio::select!` normal?

**Después de Fase 6:**
¿Qué garantiza el compilador cuando hago match sobre ModalState?

---

## Cuando te atasques

**Error del compilador que no entiendes:**
Copia el error completo y pregúntale a Claude Code:
"Recibe este error de Rust. Explícame qué está diciendo el compilador
y qué concepto de Rust está protegiéndo, antes de darme la solución"

**Concepto que no cuaja:**
"Explícame [ownership / lifetimes / traits] con un ejemplo del
código de hiveTui que ya escribimos, no con un ejemplo abstracto"

**Duda de diseño:**
"En hiveTui tengo que [hacer X]. ¿Cuál es la forma idiomática en Rust?
¿Hay un patrón establecido para esto?"

---

## Lo que este proyecto te enseña del mundo real

Al terminar hiveTui habrás tocado:
- Ownership y borrowing en código de producción
- Enums con datos como máquinas de estado
- async/await con tokio y canales mpsc
- Serde para protocolos JSON
- Pattern matching exhaustivo en un sistema real
- Tests unitarios de lógica de estado
- Separación de renderizado (Ratatui) de estado (structs puros)

Ese es el 80% de Rust que se usa en proyectos reales.
Lo que falta (lifetimes explícitos, unsafe, macros propios) aparece
solo cuando lo necesitas — y ya tendrás base suficiente para entenderlo.