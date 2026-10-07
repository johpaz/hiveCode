pub mod canvas;
pub mod cell;
pub mod rect;
pub mod style;

pub use canvas::Canvas;
pub use cell::Cell;
pub use rect::Rect;
pub use style::Style;

pub use crossterm::style::Color;

// ── Ámbar — identidad hiveCode ─────────────────────────────────────────────
pub const AMBER_BRIGHT: Color = Color::Rgb { r: 255, g: 184, b: 0   }; // #FFB800
pub const AMBER:        Color = Color::Rgb { r: 212, g: 146, b: 10  }; // #D4920A
pub const AMBER_DIM:    Color = Color::Rgb { r: 138, g: 95,  b: 7   }; // #8A5F07
pub const AMBER_SUBTLE: Color = Color::Rgb { r: 61,  g: 44,  b: 10  }; // #3D2C0A

// ── Texto ──────────────────────────────────────────────────────────────────
pub const WHITE:     Color = Color::Rgb { r: 232, g: 220, b: 200 }; // #E8DCC8 crema
pub const SECONDARY: Color = Color::Rgb { r: 154, g: 143, b: 122 }; // #9A8F7A
pub const DIM:       Color = Color::Rgb { r: 74,  g: 66,  b: 56  }; // #4A4238

// ── Fondos ─────────────────────────────────────────────────────────────────
pub const BG_MAIN:     Color = Color::Rgb { r: 13, g: 11, b: 7  }; // #0D0B07
pub const BG_PANEL:    Color = Color::Rgb { r: 20, g: 18, b: 9  }; // #141209
pub const BG_ELEVATED: Color = Color::Rgb { r: 28, g: 24, b: 16 }; // #1C1810
pub const BG_CONFLICT: Color = Color::Rgb { r: 31, g: 10, b: 10 }; // #1F0A0A

// ── Semánticos ─────────────────────────────────────────────────────────────
pub const GREEN:  Color = Color::Rgb { r: 74,  g: 222, b: 128 }; // #4ADE80
pub const BLUE:   Color = Color::Rgb { r: 74,  g: 158, b: 255 }; // #4A9EFF running
pub const RED:    Color = Color::Rgb { r: 248, g: 113, b: 113 }; // #F87171
pub const YELLOW: Color = Color::Rgb { r: 252, g: 211, b: 77  }; // #FCD34D

// ── Workers ────────────────────────────────────────────────────────────────
pub const PURPLE: Color = Color::Rgb { r: 129, g: 140, b: 248 }; // #818CF8 arch
pub const CYAN:   Color = Color::Rgb { r: 52,  g: 211, b: 153 }; // #34D399 frontend
pub const PINK:   Color = Color::Rgb { r: 251, g: 113, b: 133 }; // #FB7185 security
pub const LAVENDER: Color = Color::Rgb { r: 167, g: 139, b: 250 }; // #A78BFA devops
// ── Workers (extensión) ────────────────────────────────────────────────────
//(product_manager / data_scientist ya competían por GREEN; reviewer y los roles
// on-demand caían en SECONDARY, indistinguible del texto apagado. Un rol sin
// color propio se lee como "inactivo", así que cada uno necesita tono propio.)
pub const TEAL:   Color = Color::Rgb { r: 45, g: 212, b: 191 }; // #2DD4BF product_manager
pub const MINT:   Color = Color::Rgb { r: 163, g: 230, b: 53 }; // #A3E635 data_scientist
pub const CORAL:  Color = Color::Rgb { r: 251, g: 146, b: 60  }; // #FB923C forensic
pub const SLATE:  Color = Color::Rgb { r: 148, g: 163, b: 184 }; // #94A3B8 librarian
pub const SKY:    Color = Color::Rgb { r: 56, g: 189, b: 248 }; // #38BDF8 scout
pub const ORCHID: Color = Color::Rgb { r: 192, g: 132, b: 252 }; // #C084FC spider
