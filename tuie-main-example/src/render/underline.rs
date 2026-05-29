//! Underline decoration variants.

/// Underline decoration style.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UnderlineType {
    /// No underline.
    None = 0,
    /// Single straight underline.
    Single = 1,
    /// Double straight underline.
    Double = 2,
    /// Dotted underline.
    Dotted = 3,
    /// Dashed underline.
    Dashed = 4,
    /// Curly underline.
    Curly = 5,
}

impl std::fmt::Display for UnderlineType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => write!(f, "None"),
            Self::Single => write!(f, "Single"),
            Self::Double => write!(f, "Double"),
            Self::Dotted => write!(f, "Dotted"),
            Self::Dashed => write!(f, "Dashed"),
            Self::Curly => write!(f, "Curly"),
        }
    }
}
