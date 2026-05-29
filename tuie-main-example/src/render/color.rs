//! Terminal color types.

/// Terminal color in default, RGB, or 256-color palette form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    /// Terminal default foreground.
    Foreground,
    /// Terminal default background.
    Background,
    /// Truecolor RGB triple.
    Rgb(u8, u8, u8),
    /// 256-color palette index.
    Base256(u8),
}

impl Color {
    /// ANSI palette index 0.
    pub const BLACK: Color = Color::Base256(0);
    /// ANSI palette index 1.
    pub const RED: Color = Color::Base256(1);
    /// ANSI palette index 2.
    pub const GREEN: Color = Color::Base256(2);
    /// ANSI palette index 3.
    pub const YELLOW: Color = Color::Base256(3);
    /// ANSI palette index 4.
    pub const BLUE: Color = Color::Base256(4);
    /// ANSI palette index 5.
    pub const MAGENTA: Color = Color::Base256(5);
    /// ANSI palette index 6.
    pub const CYAN: Color = Color::Base256(6);
    /// ANSI palette index 7.
    pub const WHITE: Color = Color::Base256(7);
    /// ANSI palette index 8.
    pub const BRIGHT_BLACK: Color = Color::Base256(8);
    /// ANSI palette index 9.
    pub const BRIGHT_RED: Color = Color::Base256(9);
    /// ANSI palette index 10.
    pub const BRIGHT_GREEN: Color = Color::Base256(10);
    /// ANSI palette index 11.
    pub const BRIGHT_YELLOW: Color = Color::Base256(11);
    /// ANSI palette index 12.
    pub const BRIGHT_BLUE: Color = Color::Base256(12);
    /// ANSI palette index 13.
    pub const BRIGHT_MAGENTA: Color = Color::Base256(13);
    /// ANSI palette index 14.
    pub const BRIGHT_CYAN: Color = Color::Base256(14);
    /// ANSI palette index 15.
    pub const BRIGHT_WHITE: Color = Color::Base256(15);

    /// Returns true for [`Color::Foreground`] or [`Color::Background`].
    pub const fn is_default(&self) -> bool {
        matches!(self, Color::Foreground | Color::Background)
    }

    /// Returns a 256-color palette entry from the 6x6x6 cube. Values are clamped to 0..=5.
    pub const fn color256(r: u8, g: u8, b: u8) -> Color {
        let r = if r > 5 { 5 } else { r };
        let g = if g > 5 { 5 } else { g };
        let b = if b > 5 { 5 } else { b };
        Color::Base256(16 + r * 36 + g * 6 + b)
    }

    /// Returns a 256-color palette entry from the 24-step greyscale ramp. `shade` is clamped to 0..=23.
    pub const fn grey256(shade: u8) -> Color {
        let shade = if shade > 23 { 23 } else { shade };
        Color::Base256(232 + shade)
    }

    /// Returns the color packed into a 26-bit representation with a 2-bit tag in the high bits.
    pub const fn into_bits(&self) -> u32 {
        match *self {
            Color::Foreground => 0,
            Color::Base256(v) => (1u32 << 24) | (v as u32),
            Color::Rgb(r, g, b) => {
                (2u32 << 24)
                    | ((r as u32) << 16)
                    | ((g as u32) << 8)
                    | (b as u32)
            }
            Color::Background => 3u32 << 24,
        }
    }

    /// Returns the color decoded from the packed representation produced by [`Color::into_bits`].
    pub const fn from_bits(value: u32) -> Self {
        let v = value & 0x03FF_FFFF;
        match (v >> 24) & 0b11 {
            0 => Color::Foreground,
            1 => Color::Base256((v & 0xFF) as u8),
            2 => Color::Rgb(
                ((v >> 16) & 0xFF) as u8,
                ((v >> 8) & 0xFF) as u8,
                (v & 0xFF) as u8,
            ),
            3 => Color::Background,
            _ => unreachable!(),
        }
    }
}

/// Error returned when a string cannot be parsed as a [`Color`].
#[derive(Debug)]
pub struct ColorParseError(String);

impl std::fmt::Display for ColorParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ColorParseError {}

/// Parses a colour like `red`, `bright-blue`, `#ff8800`, or `42`.
impl std::str::FromStr for Color {
    type Err = ColorParseError;
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        let s = s.trim();
        let (hex, had_prefix) = s
            .strip_prefix('#')
            .or_else(|| s.strip_prefix("0x"))
            .or_else(|| s.strip_prefix("0X"))
            .map(|stripped| (stripped, true))
            .unwrap_or((s, false));
        if !had_prefix && s.len() <= 3 {
            if let Ok(n) = s.parse::<u8>() {
                return Ok(Color::Base256(n));
            }
        }
        let hex_byte = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
        let parsed = match hex.len() {
            2 if had_prefix => hex_byte(0..2).map(Color::Base256),
            3 if had_prefix => match (hex_byte(0..1), hex_byte(1..2), hex_byte(2..3)) {
                (Some(r), Some(g), Some(b)) => Some(Color::Rgb(r * 0x11, g * 0x11, b * 0x11)),
                _ => None,
            },
            6 => match (hex_byte(0..2), hex_byte(2..4), hex_byte(4..6)) {
                (Some(r), Some(g), Some(b)) => Some(Color::Rgb(r, g, b)),
                _ => None,
            },
            _ => None,
        };
        if let Some(color) = parsed {
            return Ok(color);
        }
        match s.to_lowercase().replace('_', "-").as_str() {
            "fg" | "foreground" => Ok(Color::Foreground),
            "bg" | "background" => Ok(Color::Background),
            "black" => Ok(Color::BLACK),
            "red" => Ok(Color::RED),
            "blue" => Ok(Color::BLUE),
            "green" => Ok(Color::GREEN),
            "cyan" => Ok(Color::CYAN),
            "magenta" => Ok(Color::MAGENTA),
            "yellow" => Ok(Color::YELLOW),
            "white" => Ok(Color::WHITE),
            "bright-black" => Ok(Color::BRIGHT_BLACK),
            "bright-red" => Ok(Color::BRIGHT_RED),
            "bright-green" => Ok(Color::BRIGHT_GREEN),
            "bright-yellow" => Ok(Color::BRIGHT_YELLOW),
            "bright-blue" => Ok(Color::BRIGHT_BLUE),
            "bright-magenta" => Ok(Color::BRIGHT_MAGENTA),
            "bright-cyan" => Ok(Color::BRIGHT_CYAN),
            "bright-white" => Ok(Color::BRIGHT_WHITE),
            _ => Err(ColorParseError(format!("invalid color '{}', expected 0-255, hex (#rrggbb), or color name", s))),
        }
    }
}

impl std::fmt::Display for Color {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Color::Foreground => write!(f, "Foreground"),
            Color::Background => write!(f, "Background"),
            Color::Rgb(r, g, b) => write!(f, "Rgb({}, {}, {})", r, g, b),
            Color::Base256(idx) => write!(f, "Base256({})", idx),
        }
    }
}
