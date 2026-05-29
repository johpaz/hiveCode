//! Character classification used for word-wise editor motion.

/// Coarse category of a character used for word-wise editor motion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharClass {
    /// Alphanumeric character or underscore.
    Word,
    /// Whitespace character.
    Whitespace,
    /// Any other non-whitespace character.
    Symbol,
}

/// Classifies a value into a [`CharClass`].
pub trait GetCharClass {
    /// Returns the [`CharClass`] of `self`.
    fn get_class(&self) -> CharClass;
}

impl CharClass {
    const fn build_ascii_table() -> [CharClass; 128] {
        let mut t = [CharClass::Symbol; 128];
        let mut i: usize = 0;
        while i < 128 {
            let c = i as u8;
            if c == b'\t' || c == b'\n' || c == 0x0B || c == 0x0C || c == b'\r' || c == b' ' {
                t[i] = CharClass::Whitespace;
            } else if (c >= b'0' && c <= b'9')
                || (c >= b'A' && c <= b'Z')
                || (c >= b'a' && c <= b'z')
                || c == b'_'
            {
                t[i] = CharClass::Word;
            }
            i += 1;
        }
        t
    }

    const ASCII_TABLE: [CharClass; 128] = Self::build_ascii_table();
}

impl GetCharClass for char {
    fn get_class(&self) -> CharClass {
        let c = *self;
        if (c as u32) < 128 {
            return CharClass::ASCII_TABLE[c as usize];
        }
        if c.is_alphanumeric() || c == '_' {
            return CharClass::Word;
        }
        if c.is_whitespace() {
            return CharClass::Whitespace;
        }
        CharClass::Symbol
    }
}

impl GetCharClass for str {
    fn get_class(&self) -> CharClass {
        let bytes = self.as_bytes();
        if !bytes.is_empty() && bytes[0] < 0x80 {
            return CharClass::ASCII_TABLE[bytes[0] as usize];
        }
        self.chars().next().unwrap().get_class()
    }
}

impl std::fmt::Display for CharClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Word => write!(f, "Word"),
            Self::Whitespace => write!(f, "Whitespace"),
            Self::Symbol => write!(f, "Symbol"),
        }
    }
}
