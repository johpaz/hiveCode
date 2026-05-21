use super::style::Style;

/// Una celda del terminal: un carácter con su estilo.
///
/// Es la unidad mínima de nuestro buffer. El canvas almacena W×H celdas.
///
/// Por qué `#[derive(Clone, PartialEq)]`:
/// - `Clone`: necesitamos copiar celdas del buffer back al front después del flush.
/// - `PartialEq`: el diff del flush compara `new_cell != old_cell` para saber si
///   hay que enviar el carácter al terminal. Sin PartialEq no podríamos usar `!=`.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub ch:    char,
    pub style: Style,
}

impl Default for Cell {
    fn default() -> Self {
        // Un espacio con estilo reset = celda "vacía" (fondo del terminal)
        Self { ch: ' ', style: Style::default() }
    }
}

impl Cell {
    pub fn new(ch: char, style: Style) -> Self {
        Self { ch, style }
    }
}
