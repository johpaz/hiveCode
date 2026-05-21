use std::io::Write;

use crossterm::{
    cursor::MoveTo,
    style::{
        Attribute, Print, ResetColor, SetAttribute, SetBackgroundColor,
        SetForegroundColor,
    },
    queue,
};

use super::{cell::Cell, rect::Rect, style::Style};

/// Motor de renderizado con double-buffering y diff rendering.
///
/// ## ¿Por qué dos buffers?
///
/// El terminal es lento comparado con la memoria RAM. Cada carácter que enviamos
/// requiere escribir bytes en el file descriptor del terminal (un pipe o un PTY).
/// Si redibujamos TODO el terminal en cada frame (60 FPS × 80×24 chars = 115,200
/// caracteres/seg), el terminal parpadea y el CPU se dispara.
///
/// La solución: mantener dos copias de la pantalla en memoria:
///   - `front`: lo que el terminal YA muestra actualmente.
///   - `back`: lo que queremos mostrar en el próximo frame.
///
/// En `flush()` comparamos ambos buffers. Solo enviamos al terminal los caracteres
/// que CAMBIARON. Si 90% de la pantalla no cambió, enviamos solo el 10%.
///
/// ## ¿Por qué un Vec<Cell> plano en lugar de Vec<Vec<Cell>>?
///
/// ```
/// // Vec<Vec<Cell>> — 2D con indirección extra:
/// //
/// //  back: Vec<Vec<Cell>>
/// //        ├── Row 0: ──→ [Cell, Cell, ...] (heap alloc #1)
/// //        ├── Row 1: ──→ [Cell, Cell, ...] (heap alloc #2)
/// //        └── Row N: ──→ [Cell, Cell, ...] (heap alloc N)
/// //
/// // Acceder back[y][x]:
/// //   1. Desreferenciar Vec externo → puntero a Row y
/// //   2. Desreferenciar Row y → Cell
/// //   → 2 desreferencias, rows en posiciones aleatorias del heap (cache miss)
///
/// // Vec<Cell> plano — 1D con aritmética de índice:
/// //
/// //  back: Vec<Cell> ──→ [C,C,C,C,...,C,C,C] (UNA heap alloc)
/// //
/// // Acceder back[y * w + x]:
/// //   1. Una multiplicación + suma (aritmética entero)
/// //   2. Una desreferencia directa
/// //   → Todos los cells están CONTIGUOS en memoria → CPU prefetch → fast
/// ```
pub struct Canvas {
    pub w: u16,
    pub h: u16,
    /// Lo que el terminal actualmente muestra (referencia del estado anterior).
    front: Vec<Cell>,
    /// Lo que vamos a dibujar ahora (escribimos aquí, luego hacemos flush).
    back: Vec<Cell>,
}

impl Canvas {
    /// Crea un canvas del tamaño dado. Ambos buffers empiezan vacíos (espacios).
    pub fn new(w: u16, h: u16) -> Self {
        let n = w as usize * h as usize;
        Self {
            w, h,
            front: vec![Cell::default(); n],
            back:  vec![Cell::default(); n],
        }
    }

    /// Retorna el Rect que cubre toda la pantalla.
    pub fn area(&self) -> Rect {
        Rect::new(0, 0, self.w, self.h)
    }

    /// Limpia el buffer back (lo llena de espacios con estilo por defecto).
    /// Se llama al inicio de cada frame, ANTES de que los widgets dibujen.
    pub fn clear(&mut self) {
        for cell in &mut self.back {
            *cell = Cell::default();
        }
    }

    /// Invalida el buffer front (fuerza redibujado completo en el próximo flush).
    /// Se usa después de un resize o cuando el terminal fue suspendido/resumido.
    pub fn force_redraw(&mut self) {
        // Un char '\0' nunca es igual a ningún char visible, así que el diff
        // encontrará que TODO cambió y enviará cada celda al terminal.
        for cell in &mut self.front {
            cell.ch = '\0';
        }
    }

    /// Redimensiona los buffers. El front se invalida para forzar redibujado completo.
    pub fn resize(&mut self, w: u16, h: u16) {
        self.w = w;
        self.h = h;
        let n = w as usize * h as usize;
        self.front = vec![Cell { ch: '\0', style: Style::default() }; n]; // '\0' = inválido
        self.back  = vec![Cell::default(); n];
    }

    // ── Primitivas de dibujo (escriben en `back`) ─────────────────────────────

    /// Coloca una celda en la posición (x, y). Silenciosamente descarta si está
    /// fuera del canvas (sin panic — los widgets no deberían preocuparse por límites).
    #[inline]
    pub fn put(&mut self, x: u16, y: u16, cell: Cell) {
        if x < self.w && y < self.h {
            // Por qué `as usize` explícito: `u16 * u16` podría overflow en u16.
            // Multiplicamos en usize para evitar eso.
            self.back[y as usize * self.w as usize + x as usize] = cell;
        }
    }

    /// Escribe texto horizontal a partir de (x, y) con un estilo uniforme.
    /// Los caracteres que caen fuera del canvas se descartan.
    pub fn print(&mut self, x: u16, y: u16, text: &str, style: Style) {
        for (i, ch) in text.chars().enumerate() {
            // i es usize; saturating_add evita overflow si x+i > u16::MAX
            let cx = x.saturating_add(i as u16);
            self.put(cx, y, Cell::new(ch, style));
        }
    }

    /// Rellena un rectángulo completo con un carácter y estilo.
    pub fn fill_rect(&mut self, r: Rect, ch: char, style: Style) {
        for row in r.y..r.bottom() {
            for col in r.x..r.right() {
                self.put(col, row, Cell::new(ch, style));
            }
        }
    }

    /// Dibuja una línea horizontal de `len` caracteres `ch`.
    pub fn hline(&mut self, x: u16, y: u16, len: u16, ch: char, style: Style) {
        for i in 0..len {
            self.put(x + i, y, Cell::new(ch, style));
        }
    }

    /// Dibuja un borde de caja simple alrededor de un Rect (usando caracteres Unicode de línea).
    ///
    /// ```text
    /// ┌──────────┐
    /// │          │
    /// └──────────┘
    /// ```
    pub fn draw_border(&mut self, r: Rect, style: Style) {
        if r.w < 2 || r.h < 2 { return; }
        let (x0, y0, x1, y1) = (r.x, r.y, r.right() - 1, r.bottom() - 1);

        // Esquinas
        self.put(x0, y0, Cell::new('┌', style));
        self.put(x1, y0, Cell::new('┐', style));
        self.put(x0, y1, Cell::new('└', style));
        self.put(x1, y1, Cell::new('┘', style));

        // Bordes superior e inferior
        for x in (x0 + 1)..x1 {
            self.put(x, y0, Cell::new('─', style));
            self.put(x, y1, Cell::new('─', style));
        }

        // Bordes izquierdo y derecho
        for y in (y0 + 1)..y1 {
            self.put(x0, y, Cell::new('│', style));
            self.put(x1, y, Cell::new('│', style));
        }
    }

    /// Escribe texto centrado horizontalmente dentro de un ancho dado en la fila y.
    pub fn print_centered(&mut self, y: u16, width: u16, text: &str, style: Style) {
        let len = text.chars().count() as u16;
        let x = if len >= width { 0 } else { (width - len) / 2 };
        self.print(x, y, text, style);
    }

    // ── Flush: el diff render ────────────────────────────────────────────────

    /// Compara back vs front y envía al terminal solo las celdas que cambiaron.
    ///
    /// ## Por qué `queue!` en lugar de `execute!` o `write!`
    ///
    /// crossterm tiene dos modos de escritura:
    ///   - `execute!(out, cmd)` → escribe inmediatamente (blocking per-call)
    ///   - `queue!(out, cmd)`   → acumula en el buffer de `out` (sin write todavía)
    ///
    /// Con `queue!`, acumulamos todos los cambios del frame en el buffer del
    /// BufWriter (memoria). Al final llamamos `out.flush()` UNA SOLA VEZ.
    /// Esto significa que el kernel recibe todos los cambios en un solo syscall
    /// (write), en lugar de N syscalls (uno por celda cambiada). Menos syscalls =
    /// menos overhead = sin parpadeo visible.
    ///
    /// ## Optimización de cursor: solo MoveTo cuando es necesario
    ///
    /// Si estamos dibujando celdas consecutivas en la misma fila, el cursor del
    /// terminal ya avanza automáticamente después de cada Print. No necesitamos
    /// emitir MoveTo para cada celda — solo cuando el cursor "salta" a una posición
    /// no consecutiva.
    pub fn flush(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        // Estado actual del terminal (para evitar emitir secuencias redundantes)
        let mut last_fg   = crossterm::style::Color::Reset;
        let mut last_bg   = crossterm::style::Color::Reset;
        let mut last_bold = false;
        let mut last_dim  = false;

        // Posición actual del cursor en el terminal (u16::MAX = desconocida)
        let mut cur_x: u16 = u16::MAX;
        let mut cur_y: u16 = u16::MAX;

        for y in 0..self.h {
            for x in 0..self.w {
                let idx = y as usize * self.w as usize + x as usize;
                let new = &self.back[idx];
                let old = &self.front[idx];

                // Saltar celdas que no cambiaron — el núcleo del diff rendering.
                if new == old {
                    // El cursor ya no está donde creíamos (saltamos sobre esta celda).
                    // La próxima celda diferente necesitará un MoveTo explícito.
                    if cur_x == x && cur_y == y { cur_x = u16::MAX; }
                    continue;
                }

                // ── Mover cursor solo si es necesario ────────────────────────
                // Si la celda anterior también cambió y estábamos en x-1 del mismo row,
                // el cursor ya está aquí (el Print anterior lo avanzó automáticamente).
                if cur_y != y || cur_x != x {
                    queue!(out, MoveTo(x, y))?;
                }

                // ── Emitir cambios de atributos ───────────────────────────────
                let s = new.style;

                // Bold: crossterm no permite "desactivar solo bold" sin reset total.
                // Si necesitamos quitar bold (last_bold=true, s.bold=false), hacemos
                // reset completo de atributos y luego reaplicamos lo que necesitamos.
                if last_bold && !s.bold {
                    queue!(out, SetAttribute(Attribute::Reset))?;
                    last_bold = false;
                    last_dim  = false;
                    last_fg   = crossterm::style::Color::Reset;
                    last_bg   = crossterm::style::Color::Reset;
                }
                if !last_bold && s.bold {
                    queue!(out, SetAttribute(Attribute::Bold))?;
                    last_bold = true;
                }
                if last_dim && !s.dim {
                    queue!(out, SetAttribute(Attribute::Reset))?;
                    last_dim  = false;
                    last_bold = false;
                    last_fg   = crossterm::style::Color::Reset;
                    last_bg   = crossterm::style::Color::Reset;
                }
                if !last_dim && s.dim {
                    queue!(out, SetAttribute(Attribute::Dim))?;
                    last_dim = true;
                }

                if s.fg != last_fg {
                    queue!(out, SetForegroundColor(s.fg))?;
                    last_fg = s.fg;
                }
                if s.bg != last_bg {
                    queue!(out, SetBackgroundColor(s.bg))?;
                    last_bg = s.bg;
                }

                // ── Emitir el carácter ────────────────────────────────────────
                queue!(out, Print(new.ch))?;

                // Actualizar front (ya enviamos este cambio al terminal)
                self.front[idx] = new.clone();

                // El cursor ahora está en la siguiente columna de esta fila
                cur_x = x.wrapping_add(1);
                cur_y = y;
            }
        }

        // Resetear colores y atributos al final del frame para no "contaminar"
        // el shell que aparece cuando el usuario sale del TUI.
        queue!(out, ResetColor)?;
        queue!(out, SetAttribute(Attribute::Reset))?;

        // UN solo flush = un solo syscall write() al terminal.
        out.flush()
    }
}
