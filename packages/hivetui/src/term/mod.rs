pub mod canvas;
pub mod cell;
pub mod rect;
pub mod style;

pub use canvas::Canvas;
pub use cell::Cell;
pub use rect::Rect;
pub use style::Style;

pub use crossterm::style::Color;

pub const AMBER:     Color = Color::AnsiValue(214);
pub const AMBER_DIM: Color = Color::AnsiValue(136);
pub const GREEN:     Color = Color::AnsiValue(114);
pub const RED:       Color = Color::AnsiValue(203);
pub const PURPLE:    Color = Color::AnsiValue(141);
pub const BLUE:      Color = Color::AnsiValue(75);
pub const CYAN:      Color = Color::AnsiValue(45);
pub const DIM:       Color = Color::AnsiValue(240);
pub const SECONDARY: Color = Color::AnsiValue(248);
pub const WHITE:     Color = Color::White;
