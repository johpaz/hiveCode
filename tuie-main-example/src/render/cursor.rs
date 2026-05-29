//! Terminal cursor shape enum.

/// Terminal cursor shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorShape {
    /// Solid block over the cell.
    Block,
    /// Vertical bar at the left edge of the cell.
    Beam,
    /// Underline along the bottom of the cell.
    Underline,
}

impl std::fmt::Display for CursorShape {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Block => write!(f, "Block"),
            Self::Beam => write!(f, "Beam"),
            Self::Underline => write!(f, "Underline"),
        }
    }
}
