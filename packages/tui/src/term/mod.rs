pub mod canvas;
pub mod cell;
pub mod rect;
pub mod style;

pub use canvas::Canvas;
pub use cell::Cell;
pub use rect::Rect;
pub use style::Style;

// ── Paleta de colores ────────────────────────────────────────────────────────
//
// Por qué `crossterm::style::Color` en lugar de definir nuestra propia enum:
// ─────────────────────────────────────────────────────────────────────────────
// crossterm es la única dependencia que queda entre nosotros y el terminal.
// Reexportar su Color evita una capa de conversión innecesaria y una enum
// duplicada que habría que mantener sincronizada.
//
// `Color::Indexed(n)` usa la paleta de 256 colores de xterm (la más compatible).
// `n` = 214 es el naranja/ámbar que identifica a hiveCode.
//
// Por qué `const` en lugar de `static`:
// ─────────────────────────────────────
// `Color` implementa `Copy`, así que es un valor que vive puramente en el
// segmento de código (zero runtime cost). `const` es preferible a `static`
// para valores `Copy` — el compilador puede inlinarlos directamente.

pub use crossterm::style::Color;

pub const AMBER:     Color = Color::Indexed(214);
pub const AMBER_DIM: Color = Color::Indexed(136);
pub const GREEN:     Color = Color::Indexed(114);
pub const RED:       Color = Color::Indexed(203);
pub const PURPLE:    Color = Color::Indexed(141);
pub const BLUE:      Color = Color::Indexed(75);
pub const CYAN:      Color = Color::Indexed(45);
pub const DIM:       Color = Color::Indexed(240);
pub const SECONDARY: Color = Color::Indexed(248);
pub const WHITE:     Color = Color::White;
