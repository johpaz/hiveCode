use crate::term::{
    Color, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_CONFLICT, BG_ELEVATED, BG_MAIN, BG_PANEL, BLUE,
    CYAN, DIM, GREEN, LAVENDER, PINK, PURPLE, RED, SECONDARY, WHITE, YELLOW,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SemanticColor {
    Background,
    Panel,
    Elevated,
    Conflict,
    Text,
    TextMuted,
    TextDim,
    Accent,
    AccentStrong,
    AccentDim,
    Success,
    Warning,
    Danger,
    Running,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub background: Color,
    pub panel: Color,
    pub elevated: Color,
    pub conflict: Color,
    pub text: Color,
    pub text_muted: Color,
    pub text_dim: Color,
    pub accent: Color,
    pub accent_strong: Color,
    pub accent_dim: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
    pub running: Color,
}

impl Theme {
    pub const HIVE: Self = Self {
        background: BG_MAIN,
        panel: BG_PANEL,
        elevated: BG_ELEVATED,
        conflict: BG_CONFLICT,
        text: WHITE,
        text_muted: SECONDARY,
        text_dim: DIM,
        accent: AMBER,
        accent_strong: AMBER_BRIGHT,
        accent_dim: AMBER_DIM,
        success: GREEN,
        warning: YELLOW,
        danger: RED,
        running: BLUE,
    };

    pub fn resolve(self, color: SemanticColor) -> Color {
        match color {
            SemanticColor::Background => self.background,
            SemanticColor::Panel => self.panel,
            SemanticColor::Elevated => self.elevated,
            SemanticColor::Conflict => self.conflict,
            SemanticColor::Text => self.text,
            SemanticColor::TextMuted => self.text_muted,
            SemanticColor::TextDim => self.text_dim,
            SemanticColor::Accent => self.accent,
            SemanticColor::AccentStrong => self.accent_strong,
            SemanticColor::AccentDim => self.accent_dim,
            SemanticColor::Success => self.success,
            SemanticColor::Warning => self.warning,
            SemanticColor::Danger => self.danger,
            SemanticColor::Running => self.running,
        }
    }

    pub fn worker(self, name: &str) -> Color {
        let lower = name.to_ascii_lowercase();
        if lower.contains("bee") || lower.contains("product") {
            AMBER_BRIGHT
        } else if lower.contains("arch") {
            PURPLE
        } else if lower.contains("front") {
            CYAN
        } else if lower.contains("back") {
            BLUE
        } else if lower.contains("sec") {
            PINK
        } else if lower.contains("test") || lower.contains("qa") {
            YELLOW
        } else if lower.contains("devops") || lower.contains("integration") {
            LAVENDER
        } else if lower.contains("data") || lower.contains("dba") {
            GREEN
        } else {
            self.text_muted
        }
    }
}

impl Default for Theme {
    fn default() -> Self {
        Self::HIVE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_semantic_colors() {
        let theme = Theme::default();
        assert_eq!(theme.resolve(SemanticColor::AccentStrong), AMBER_BRIGHT);
        assert_eq!(theme.resolve(SemanticColor::Danger), RED);
    }

    #[test]
    fn maps_worker_roles() {
        let theme = Theme::default();
        assert_eq!(theme.worker("architecture"), PURPLE);
        assert_eq!(theme.worker("frontend"), CYAN);
        assert_eq!(theme.worker("unknown"), SECONDARY);
    }
}
