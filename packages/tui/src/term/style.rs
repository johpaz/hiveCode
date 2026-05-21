use crossterm::style::Color;

/// Estilo visual de una celda: colores + atributos de texto.
///
/// Usamos `Color::Reset` como sentinela de "sin color explícito", así evitamos
/// `Option<Color>` y el unwrapping asociado. El patrón builder permite encadenar:
///   `Style::new().fg(AMBER).bold()`
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Style {
    pub fg:   Color,
    pub bg:   Color,
    pub bold: bool,
    pub dim:  bool,
}

impl Default for Style {
    fn default() -> Self {
        // Reset en ambos colores = "hereda el color del terminal del usuario"
        Self { fg: Color::Reset, bg: Color::Reset, bold: false, dim: false }
    }
}

// ── Builder API ───────────────────────────────────────────────────────────────
//
// Por qué los métodos reciben `self` por VALOR (no `&mut self`):
// ---------------------------------------------------------------
// Si recibiéramos `&mut self` el caller tendría que declarar `let mut s = Style::new()`
// y luego llamar `s.fg(AMBER); s.bold();` en pasos separados.
//
// Con `self` por valor, Rust mueve la struct, modifica una copia y la retorna.
// Esto permite encadenamiento: `Style::new().fg(AMBER).bold()` sin `mut`.
// El compilador elimina las copias intermedias (zero-cost abstraction).

impl Style {
    pub fn new() -> Self { Self::default() }

    /// Establece el color de frente y retorna el nuevo Style.
    pub fn fg(mut self, color: Color) -> Self {
        self.fg = color;
        self
    }

    /// Establece el color de fondo.
    pub fn bg(mut self, color: Color) -> Self {
        self.bg = color;
        self
    }

    /// Activa negrita.
    pub fn bold(mut self) -> Self {
        self.bold = true;
        self
    }

    /// Activa texto tenue (dim).
    pub fn dim(mut self) -> Self {
        self.dim = true;
        self
    }
}
