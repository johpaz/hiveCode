# hiveTui — Documento de Diseño Visual
**Tipo:** Design Document — sin código, solo instrucciones de diseño  
**Para:** implementador del TUI (Claude Code + Johpaz)  
**Referencia:** Investigación "Más Allá del Código Generado" + identidad hiveCode  
**Fecha:** Mayo 2026

---

## 1. Filosofía de diseño

### El concepto

hiveTui vive en la tensión entre dos mundos:
lo **orgánico** (colmena, miel, ámbar, hexágonos, vida en colectivo)
y lo **técnico** (terminal oscura, código, precisión, velocidad).

El diseño no elige entre los dos — los fusiona.
Un entorno oscuro y preciso con calidez ámbar como acento dominante.
Bordes que sugieren hexágonos sin ser decoración vacía.
Una mascota que vive en la interfaz con naturalidad.

### Los tres principios

**Claridad sobre densidad:**
Cada píxel de información en pantalla debe ganarse su lugar.
Si algo no ayuda al dev a tomar una decisión, no debería estar visible por defecto.

**Calidez funcional:**
El ámbar no es solo estético — comunica actividad, atención, vida.
Lo que está activo es cálido. Lo que espera es frío. Lo que falló es rojo.
El color siempre tiene semántica.

**Velocidad percibida:**
Un TUI premium no es solo rápido — se *siente* rápido.
Las animaciones son mínimas y con propósito.
Los cambios de estado son inmediatos y visibles.
El cursor siempre está exactamente donde el dev espera.

---

## 2. Sistema de color

### Paleta base

El fondo no es negro puro — es un negro con leve tinte cálido.
Negro puro en terminal se siente frío y duro para sesiones largas.
El tinte cálido es casi imperceptible pero reduce la fatiga visual.

```
FONDO PRINCIPAL     #0D0B07   negro con tinte ámbar muy sutil
FONDO PANELES       #141209   ligeramente más claro que el fondo
FONDO ELEVADO       #1C1810   para modales y elementos flotantes
BORDE SUTIL         #2A2318   bordes de paneles — casi invisible
BORDE ACTIVO        #3D3020   borde de panel con foco
```

### Tipografía de texto

```
TEXTO PRINCIPAL     #E8DCC8   crema — no blanco puro, reduce fatiga
TEXTO SECUNDARIO    #9A8F7A   para metadatos, timestamps, labels
TEXTO DESHABILITADO #4A4238   para contenido inactivo
TEXTO INVERTIDO     #0D0B07   texto oscuro sobre fondos claros
```

### Acento primario — el ámbar

Es el color de hiveCode. Bee, checkpoints activos, modo activo,
el prompt del input, los elementos seleccionados.

```
AMBER_BRIGHT    #FFB800   ámbar brillante — solo para elementos críticos
AMBER_PRIMARY   #D4920A   ámbar principal — uso general
AMBER_DIM       #8A5F07   ámbar apagado — hover, inactive
AMBER_SUBTLE    #3D2C0A   ámbar muy sutil — fondos de highlight
```

### Lenguaje de estado — semántica universal

Estos colores tienen significado fijo en todo el TUI.
No se usan para decoración — solo para comunicar estado.

```
RUNNING   #4A9EFF   azul — activo, en progreso
DONE      #4ADE80   verde — completado exitosamente
WARNING   #FCD34D   amarillo — atención requerida, riesgo medio
ERROR     #F87171   rojo claro — error, riesgo alto
CRITICAL  #EF4444   rojo — crítico, requiere acción inmediata
WAITING   #6B7280   gris — inactivo, esperando
```

### Colores semánticos de archivo (File Risk Map)

```
RIESGO BAJO       mismo que DONE     #4ADE80
RIESGO MEDIO      mismo que WARNING  #FCD34D
RIESGO ALTO       mismo que ERROR    #F87171
RIESGO CRÍTICO    mismo que CRITICAL #EF4444
ARCHIVO NUEVO     #818CF8   violeta suave — creación
ARCHIVO BORRADO   #FB7185   rosa — eliminación
```

### Colores de workers

Cada worker tiene un color de identidad consistente en todo el TUI.
Cuando ves ese color en cualquier panel, sabes inmediatamente de quién es.

```
BEE (coordinador)   #FFB800   ámbar — el jefe de la colmena
ARCHITECTURE        #818CF8   violeta
BACKEND             #4A9EFF   azul
FRONTEND            #34D399   verde menta
SECURITY            #FB7185   rosa
TEST                #FBBF24   amarillo
DEVOPS              #A78BFA   lavanda
```

---

## 3. Lenguaje visual — el hexágono

### Por qué el hexágono

La colmena está construida de hexágonos por eficiencia matemática —
es la forma que maximiza espacio con mínima estructura.
En el TUI, el hexágono aparece como referencia sutil, no como decoración literal.

### Cómo se expresa en terminal

**Bordes de panel con esquinas hexagonales:**
En vez de las esquinas cuadradas estándar de ratatui (`┌─┐└─┘`),
usar esquinas que sugieren el hexágono con caracteres Unicode:

```
Panel estándar:     Panel hiveTui:
┌──────────┐        ⬡──────────⬡
│          │        │          │
└──────────┘        ⬡──────────⬡
```

Las esquinas `⬡` son el único cambio — el resto de bordes son líneas normales.
Sutil. No distrae. Pero reconocible.

**El separador de secciones:**
En vez de una línea horizontal simple `────────`,
usar un patrón que evoca el patrón hexagonal:

```
⬡ ─── ⬡ ─── ⬡ ─── ⬡ ─── ⬡
```

Solo para separadores principales — entre el header y el área central,
entre el área central y la checkpoint bar.

**El indicador de worker activo:**
Un hexágono pequeño lleno `⬡` para activo, vacío `⬡` con dimming para inactivo.
No usar bullets `•` ni guiones — usar el lenguaje de la colmena.

**El prompt del input:**
En vez de `>` o `$`, usar `⬡` en color ámbar.
Es el único lugar donde el hexágono tiene color ámbar sólido.
El dev sabe instantáneamente dónde está el foco.

---

## 4. Layout y espaciado

### Principios de espaciado

La terminal no tiene píxeles — tiene celdas de caracteres.
El espaciado se logra con celdas vacías estratégicas.

**Regla del respiro:**
Todo bloque de contenido tiene exactamente 1 celda de padding lateral.
No 2, no 0 — siempre 1. Esto crea consistencia visual en toda la interfaz.

**Regla de densidad máxima:**
El área central nunca tiene más de 3 columnas de información simultánea.
Dos columnas es el óptimo para la mayoría de layouts.
Tres solo en Dashboard donde la comparación de workers lo justifica.

### Dimensiones del layout principal

```
┌─ HEADER ──────────────────────────────────────────────── 1 línea ─┐
│                                                                    │
│                    ÁREA CENTRAL                                    │
│                  (altura variable)                                 │
│                                                                    │
⬡ ─── CHECKPOINT BAR ──────────────────────────────────── 1 línea ─⬡
│  CONFLICTOS (solo si hay)                                2 líneas  │
│  LOGS (solo si activos)                                  3 líneas  │
├─ BOTTOM BAR ──────────────────────────────────────────── 1 línea ─┤
│  mascota │ input                              │ [MODO] [⛔]        │
└──────────────────────────────────────────────────────────────────┘
```

### El header — información siempre visible

El header es una sola línea que contiene todo lo que el dev necesita
saber sobre el estado de la sesión sin hacer nada.

Estructura izquierda a derecha:

```
⬡ hiveCode  ·  anthropic · claude-sonnet  ·  [AUTO]  ·  ⬡4 workers  ·  tokens:12.4k  ·  $0.23  ·  ● 14:38
```

- `⬡ hiveCode` — logo en ámbar
- `·` — separadores en gris muy sutil
- `anthropic · claude-sonnet` — provider y modelo en texto secundario
- `[AUTO]` — modo con color semántico (azul=plan, amarillo=approval, verde=auto)
- `⬡4 workers` — número de workers activos con hexágono
- `tokens:12.4k` — contador de tokens en texto secundario
- `$0.23` — costo en ámbar dim
- `●` — indicador de running (verde=corriendo, gris=pausado)
- `14:38` — hora local en texto secundario

**Regla:** si la terminal es muy angosta, los elementos se omiten de derecha a izquierda.
El modo y el logo nunca desaparecen.

### El bottom bar — el único lugar fijo del dev

El bottom bar es el espacio del desarrollador. Siempre visible, siempre en la misma posición.

```
⬡  _cursor_aquí_                                                [PLAN] ⛔
```

- `⬡` en ámbar brillante — el prompt hexagonal, identidad visual del input
- El input ocupa todo el espacio central disponible
- `[PLAN]` — badge del modo en color semántico, esquinas `[ ]`
- `⛔` — botón de HALT, rojo si hay conflictos críticos activos, gris si no

**El cursor del input:**
Debe ser siempre visible. Nunca desaparecer bajo el contenido.
El scroll horizontal es silencioso — el texto se desliza, el cursor no se mueve de posición.

---

## 5. Diseño de cada layout

### Layout::Focus — historial full screen

El layout por defecto. Máxima atención al diálogo con los agentes.

```
⬡ hiveCode  ·  claude-sonnet  ·  [AUTO]  ·  ● running
⬡──────────────────────────────────────────────────────⬡
│                                                      │
│  👤 Tú                                     14:20    │
│  implementa JWT refresh token con blacklist          │
│                                                      │
│  ⬡ Bee                                    14:21    │
│  Analicé el codebase. ADR-003 requiere               │
│  migration script para cambios al schema.            │
│  Mi plan:                                            │
│  1. Tabla token_blacklist en schema.ts               │
│  2. Migration con drizzle-kit                        │
│  3. Middleware en auth/                              │
│                                                      │
│  🔵 backend                               14:23    │
│  Creando auth/middleware.ts...                       │
│                                                 ▐    │
⬡ ── cp_14:21 ── cp_14:28 ── [cp_14:35 ●] ──────────⬡
⬡  _                                          [AUTO] ⛔
```

**Detalles de diseño:**
- Mensajes del dev: color de texto principal, sin icono especial
- Mensajes de Bee: `⬡` en ámbar antes del nombre
- Mensajes de workers: círculo de color del worker antes del nombre
- Timestamps: alineados a la derecha, en texto secundario
- El scrollbar lateral: delgado, `▐` como thumb, solo visible si hay contenido
- Separación entre mensajes: 1 línea vacía — no más

### Layout::Plan — exploración y razonamiento

Cuando el agente está pensando, el dev necesita ver el razonamiento
y qué archivos están en riesgo.

```
⬡ hiveCode  ·  [PLAN]  ·  ⬡ Bee pensando...
⬡─────────────────────────┬────────────────────────⬡
│  RAZONAMIENTO            │  MAPA DE ARCHIVOS      │
│  ─────────────           │  ──────────────        │
│  ⬡ bee                  │  📁 src/auth/          │
│  "Revisando ADR-003      │    🟡 middleware.ts    │
│  antes de proponer       │  📁 src/database/      │
│  cambios. La decisión    │    🔴 schema.ts        │
│  dice que se requiere    │       ↳ ADR-003        │
│  migration script..."    │  📁 src/components/    │
│                          │    🟢 Button.tsx       │
│  ⬡ architecture         │                        │
│  "Analizando impacto     │  ADR RELEVANTE         │
│  en 3 módulos..."        │  ── ADR-003 ─────────  │
│                          │  "Migration script     │
│                          │   requerido para..."   │
│                          │  [Enter: ver completo] │
⬡ ── cp_14:21 ── [cp_14:32 ●] ──────────────────────⬡
⬡  /approve plan                              [PLAN] ⛔
```

**Detalles de diseño:**
- Panel izquierdo (60%): razonamiento en streaming — texto que aparece carácter a carácter
- Panel derecho (40%): mapa de archivos estático con colores de riesgo
- El nombre del worker en el panel de razonamiento: en su color de identidad
- Los archivos en el mapa: riesgo coloreado, ADR referenciado en texto secundario
- La transición de razonamiento: el texto aparece suavemente, sin parpadeo

### Layout::Code — generación activa

El foco está en el código que se está generando y el estado de los workers.

```
⬡ hiveCode  ·  [AUTO]  ·  backend: JWT middleware
⬡──────────────────────┬─────────────────────────⬡
│  src/auth/middleware  │  WORKERS                │
│  ─────────────────── │  ───────                │
│                       │  ⬡ bee         ✅ DONE  │
│  + import { sign }    │  ⬡ architecture ✅ DONE  │
│    from 'jsonwebtoken'│  ⬡ backend     🔵 CODE  │
│                       │     "JWT middleware"    │
│  - const handler =    │  ⬡ frontend    🔵 CODE  │
│  + const handler =    │     "AuthForm"          │
│    async (req, res) =>│  ⬡ security    ⚪ WAIT   │
│    if (!token) {      │  ⬡ test        ⚪ WAIT   │
│  +   return 401()     │                         │
│    }                  │  CHECKPOINT             │
│                       │  cp_14:35 · 3 archivos  │
│               ▐ 4/12  │  [↩ r para rollback]   │
⬡ ── [cp_14:35 ●] ────────────────────────────────⬡
│  backend → "Implementando refresh token logic"  │
⬡  /think                                [AUTO] ⛔
```

**Detalles de diseño:**
- Panel izquierdo (60%): diff del archivo activo
  - Líneas añadidas: `+` en verde, fondo verde muy sutil
  - Líneas eliminadas: `-` en rojo, fondo rojo muy sutil
  - Líneas de contexto: texto secundario
- Panel derecho (40%): workers con colores de identidad
- Intent bar: una línea sobre el bottom bar, en texto secundario italic
  muestra qué está haciendo el worker activo en este momento
- El nombre del worker en el panel: en su color de identidad

### Layout::Review — aprobación humana

La atención máxima. El dev necesita toda la información para decidir.

```
⬡ hiveCode  ·  [APPROVAL]  ·  esperando tu decisión
⬡──────────────────────────────────────────────────⬡
│  ADR-003: Database Schema Changes                │
│  Status: accepted                                │
│  ══════════════════════════════                  │
│                                                  │
│  ## Contexto                                     │
│  Cada cambio al schema requiere migration        │
│  script con drizzle-kit generate...              │
│                                                  │
│  ## Decisión                                     │
│  Se usará drizzle-kit para migraciones           │
│  automáticas antes de cualquier deploy...        │
│                                                  │
│  [Ctrl+↑↓ para scroll · /search para buscar]    │
│                                              ▐   │
⬡──────────────────────────────────────────────────⬡
│  ARCHIVOS:                                       │
│  ✅ src/auth/middleware.ts    47 líneas  bajo     │
│  ⚠️  src/database/schema.ts   12 líneas  ADR-003  │
│  ✅ src/components/Button.tsx  nuevo     bajo     │
⬡ ── [cp_14:35 ●] ────────────────────────────────⬡
⬡  /approve  ó  /reject  ó  /modify          [APPROVAL] ⛔
```

**Detalles de diseño:**
- El ADR ocupa la mayor parte de la pantalla — es lo que el dev necesita leer
- Markdown renderizado: headers en ámbar, código en bloques, tablas alineadas
- La lista de archivos: compacta, debajo del ADR, sin ocupar más de 4 líneas
- El badge de modo `[APPROVAL]` en amarillo — el único momento donde el badge es amarillo
- El input sugiere los comandos disponibles como placeholder

### Layout::Dashboard — supervisión del swarm

Para cuando el dev quiere ver todos los workers simultáneamente.

```
⬡ hiveCode  ·  [AUTO]  ·  6 workers  ·  $0.23  ·  14:38
⬡──────────────┬──────────────┬──────────────┬──────────⬡
│ ⬡ ARCHITECT  │ ⬡ BACKEND    │ ⬡ FRONTEND   │ ⬡ SECUR  │
│ ✅ DONE      │ 🔵 CODING    │ 🔵 CODING    │ ⚪ WAIT   │
│              │              │              │          │
│ Plan ok      │ JWT refresh  │ AuthForm     │          │
│ ADR-003 ✓    │              │              │          │
│ migration    │ 3 archivos   │ 2 nuevos     │          │
│ incluida     │ modificados  │              │          │
├──────────────┼──────────────┴──────────────┴──────────┤
│ ⬡ TEST       │                                        │
│ ⚪ WAIT       │  /focus <worker> para ver detalle      │
│              │  /layout code para volver al diff      │
└──────────────┴────────────────────────────────────────┘
⬡ ── [cp_14:35 ●] ──────────────────────────────────────⬡
⬡  /focus backend                              [AUTO] ⛔
```

**Detalles de diseño:**
- Cada worker en su celda con borde hexagonal
- El nombre del worker en su color de identidad
- La celda del worker activo tiene borde más brillante
- Las celdas de workers inactivos tienen dimming sutil
- Si hay un conflicto entre dos workers, el borde entre sus celdas se vuelve rojo

---

## 6. Widgets de detalle

### Checkpoint Bar

La línea de tiempo de puntos de restauración.
Siempre visible, siempre en la misma posición justo encima del bottom bar.

```
CHECKPOINTS  [14:21]  [14:28]  [14:32]  [14:35 ●]  ← cp activo en ámbar
```

**Cuando hay un checkpoint seleccionado:**
```
CHECKPOINTS  [14:21]  [14:28]  [14:32 ◀]  [14:35 ●]  [↩ ROLLBACK]
```

- Los checkpoints pasados: texto secundario entre corchetes
- El checkpoint activo (más reciente): ámbar brillante con `●`
- El checkpoint seleccionado: cyan con `◀`
- El texto `[↩ ROLLBACK]` aparece solo cuando hay selección, en rojo suave

### Conflict Alert

Solo aparece cuando hay conflictos activos. Ocupa máximo 3 líneas.

```
⚠ backend ↔ frontend · schema.ts  [critical]  →  /resolve para gestionar
```

- Fondo: rojo muy sutil `#1F0A0A`
- Texto: rojo claro para los nombres de workers en conflicto
- El `[critical]` en rojo brillante
- Si hay múltiples conflictos, muestran uno por línea hasta 3

### Modal de configuración

Aparece centrado, con dimming del fondo.

```
┌─ Configurar Provider ──────────────────────────┐
│                                                │
│  Provider:   [ anthropic              ]        │
│  Modelo:     [ claude-sonnet-4-6      ]        │
│  API Key:    [ **********************  ]       │
│                                                │
│  [Tab] para navegar · [Enter] confirmar · [Esc] cancelar  │
└────────────────────────────────────────────────┘
```

- Fondo del modal: `#1C1810` elevado sobre el fondo principal
- Borde: ámbar dim `#8A5F07`
- Campo activo: borde ámbar brillante
- Campo inactivo: borde sutil

### Thought Stream (razonamiento)

El panel donde el dev ve cómo piensa el agente en tiempo real.

**Diseño:**
- El texto aparece carácter a carácter mientras el agente razona
- Cada worker tiene su nombre en su color de identidad al inicio del bloque
- El bloque activo (en streaming) tiene un cursor parpadeante `▋` al final
- Los bloques completados tienen el texto completo en texto secundario ligeramente más dim
- Máximo 3 bloques visibles — el más antiguo desaparece cuando llega uno nuevo

### ADR Viewer

Para leer documentos largos dentro del TUI.

**Diseño:**
- Headers markdown `#` → texto en ámbar, subrayado con `═`
- Headers `##` → texto en ámbar dim
- Código inline → fondo ligeramente elevado, texto en verde menta
- Bloques de código → borde lateral izquierdo en ámbar, fondo elevado
- Tablas → alineadas, separadas con caracteres Unicode `┼─│`
- Citas `>` → borde lateral izquierdo en gris, texto en texto secundario
- Scrollbar lateral con marcadores: verde para secciones no vistas, gris para visitadas

---

## 7. Animaciones y transiciones

### Principio

Las animaciones en terminal deben ser imperceptibles como proceso
pero perceptibles como resultado. El dev no debe ver "algo animándose" —
debe ver que el estado cambió de forma fluida.

### Tick de la mascota — 200ms

La abeja tiene 4 frames de animación.
El cambio es sutil: una pequeña variación de posición o brillo.
No debe distraer la atención del contenido principal.

### Cursor del input

El cursor del input parpadea a 500ms (estándar de terminal).
Cuando el dev está escribiendo, el parpadeo se detiene —
solo parpadea cuando el input está idle.

### Indicador de worker running

El emoji `🔵` de un worker activo pulsa sutilmente.
Implementación: alternar entre `🔵` y un azul ligeramente más claro.
Frecuencia: 1 segundo. No más rápido — los pulsos rápidos generan ansiedad.

### Aparición del Thought Stream

El texto del razonamiento aparece carácter a carácter.
Velocidad: la que venga del stream de Bun — no hay velocidad artificial.
Si el modelo es rápido, el texto aparece rápido. Es natural.

### Transición de layout

Cuando el layout cambia (Ctrl+L o sugerencia de Bun),
el repintado completo de la pantalla se hace en un solo frame.
Sin animación de transición — la inmediatez es la señal de velocidad.

---

## 8. Tipografía de terminal

### Fuente recomendada

hiveTui usa caracteres Unicode de la fuente del sistema.
Para que el diseño se vea como se diseñó, recomendar al usuario:
- **JetBrains Mono** (primera opción — los hexágonos `⬡` se ven perfectos)
- **Fira Code** (segunda opción)
- **Hack** (tercera opción)

Documentar esto en el README: "hiveTui está optimizado para fuentes monoespaciadas
con soporte Unicode. Recomendamos JetBrains Mono."

### Caracteres Unicode usados

```
⬡   U+2B21   hexágono vacío — prompt, bordes, decoración
●   U+25CF   círculo lleno — indicador activo
▐   U+2590   bloque derecho — thumb del scrollbar
▋   U+258B   bloque izquierdo — cursor del thought stream
═   U+2550   línea doble horizontal — separadores de headers
┌┐└┘│─  bordes estándar de caja — estructura de paneles
┼─│  separadores de tabla en ADR viewer
```

### Qué no usar

- No usar caracteres Braille para barras de progreso (ilegibles en algunos terminales)
- No usar colores de 8 bits — usar siempre truecolor (256+)
- No usar bold para destacar texto en paneles de contenido —
  reservar bold solo para elementos de navegación y estados críticos

---

## 9. Comportamiento responsivo

### Anchos de terminal

El TUI debe funcionar en tres rangos de ancho:

**Estrecho (< 80 columnas):**
Solo Layout::Focus disponible. El header se reduce a `⬡ [MODO] ●`.
El bottom bar muestra solo el input y el badge de modo.
Un mensaje en el header indica que otros layouts requieren más espacio.

**Normal (80–140 columnas):**
Todos los layouts disponibles. Layout::Plan y Layout::Code con split 60/40.
Es el caso de uso principal.

**Amplio (> 140 columnas):**
Layout::Dashboard muestra hasta 4 workers en columnas.
Layout::Plan añade una tercera columna para el ADR viewer.
El header muestra toda la información sin truncar.

### Alturas de terminal

**Bajo (< 24 líneas):**
El panel de logs se oculta automáticamente.
El thought stream se desactiva.
Solo lo esencial: header, contenido principal, checkpoint bar, bottom bar.

**Normal (24–40 líneas):**
Configuración estándar.

**Alto (> 40 líneas):**
El historial y el thought stream tienen más espacio.
Los modales se ven completos sin scroll.

---

## 10. Identidad sonora (opcional v1.1)

No es prioritario pero vale documentarlo:

El TUI podría emitir sonidos sutiles del sistema para eventos críticos:
- Checkpoint creado: un click suave
- Conflicto detectado: dos tonos de alerta
- Rollback completado: un tono de confirmación

Implementado solo si el terminal soporta la bell (`\x07`) y el usuario lo activa.
Desactivado por defecto.

---

## 11. Guía de implementación del diseño

### Para Claude Code — instrucciones de diseño

Cuando implementes los widgets de ratatui, sigue estas reglas en orden:

**Regla 1 — Colores:**
Nunca usar colores hardcodeados como `Color::Yellow`.
Siempre usar los colores del sistema definidos en `src/theme.rs`.
Un cambio de tema debe cambiar toda la UI desde un solo archivo.

**Regla 2 — Bordes:**
Los paneles principales usan el set de bordes personalizado con esquinas `⬡`.
Los subpaneles dentro de un layout usan bordes sutiles o ningún borde.
Los modales usan borde con color ámbar.

**Regla 3 — Spacing:**
Siempre 1 celda de padding lateral en el contenido de los paneles.
Nunca 0 padding — el texto pegado al borde es ilegible.

**Regla 4 — Estados vacíos:**
Cada panel tiene un estado vacío diseñado.
Nunca un panel en blanco sin mensaje.
Ejemplo: historial vacío → `⬡ Escribe algo para empezar` centrado en el panel.

**Regla 5 — El bottom bar es sagrado:**
El bottom bar nunca se modifica por mensajes de Bun.
Solo el dev lo controla con su teclado.
Ningún evento externo puede mover el cursor del input.

### Archivo src/theme.rs

Antes de implementar cualquier widget, crear `src/theme.rs` con
todas las constantes de color del sistema de diseño.
Ningún widget importa colores de otro lugar — solo de theme.rs.

La estructura de theme.rs debe tener:
- Paleta base (backgrounds, texts)
- Acento primario (amber variants)
- Estado semántico (running, done, warning, error, waiting)
- Colores por worker (bee, architecture, backend, etc)
- Colores de archivo (risk levels)

---

## 12. Checklist de diseño — antes de considerar terminado

**Visual:**
- [ ] Todos los colores vienen de theme.rs — ningún color hardcodeado
- [ ] Los bordes hexagonales (`⬡`) aparecen en esquinas de paneles principales
- [ ] El prompt del input es `⬡` en ámbar brillante
- [ ] El header muestra toda la información sin truncar en 100 columnas
- [ ] La mascota aparece una sola vez en el bottom bar

**Semántica de color:**
- [ ] Worker running siempre en azul `RUNNING`
- [ ] Worker done siempre en verde `DONE`
- [ ] Riesgo crítico siempre en rojo `CRITICAL`
- [ ] Checkpoint activo siempre en ámbar `AMBER_PRIMARY`
- [ ] Modo APPROVAL siempre en amarillo `WARNING`

**Responsive:**
- [ ] Funciona en 80 columnas sin romper el layout
- [ ] El header se trunca graciosamente en terminales angostas
- [ ] Los paneles vacíos tienen mensaje de estado vacío

**Experiencia:**
- [ ] El cursor del input siempre visible sin importar la longitud del texto
- [ ] El scroll del historial funciona con scrollbar visible
- [ ] Los conflictos críticos son inmediatamente obvios sin buscarlos
- [ ] Cambiar de layout con Ctrl+L es instantáneo