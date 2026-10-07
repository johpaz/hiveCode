use crate::term::{
    Color, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_CONFLICT, BG_ELEVATED, BG_MAIN, BG_PANEL, BLUE,
    CORAL, CYAN, DIM, GREEN, LAVENDER, MINT, ORCHID, PINK, PURPLE, RED, SECONDARY, SKY, SLATE, TEAL, WHITE,
    YELLOW,
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

    /// Canonical role → colour table. Every agent colour in the app comes from
    /// here: there is no per-widget table.
    ///
    /// Matching is by substring on the lowercased internal role id, so
    /// `data_scientist_worker` and `data_scientist` land on the same colour, and
    /// an unknown id lands on `text_muted` — readable, but visibly "not a known
    /// swarm role".
    pub fn worker(role: &str) -> Color {
        const ROLES: &[(&str, Color)] = &[
            ("bee", AMBER_BRIGHT),
            ("product", TEAL),
            ("arch", PURPLE),
            ("back", BLUE),
            ("front", CYAN),
            ("data", MINT),
            ("sec", PINK),
            ("test", YELLOW),
            ("devops", LAVENDER),
            ("verif", RED),
            ("review", RED),
            ("quality", RED),
            ("forensic", CORAL),
            ("librarian", SLATE),
            ("spider", ORCHID),
            ("scout", SKY),
        ];
        let lower = role.to_ascii_lowercase();
        // The tool pool is not a swarm agent; it is the hive's own executor, so
        // it wears amber. Matched exactly — "tool" as a substring would swallow
        // unrelated role names.
        if lower == "tool" || lower == "tool_worker" {
            return AMBER;
        }
        ROLES
            .iter()
            .find(|(key, _)| lower.contains(key))
            .map(|(_, color)| *color)
            .unwrap_or(SECONDARY)
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
        assert_eq!(Theme::worker("architecture"), PURPLE);
        assert_eq!(Theme::worker("frontend"), CYAN);
        assert_eq!(Theme::worker("unknown"), SECONDARY);
    }

    #[test]
    fn matching_is_case_and_suffix_insensitive() {
        // The roster may append suffixes ("backend_worker"); same role, same colour.
        assert_eq!(Theme::worker("Backend"), Theme::worker("backend_worker"));
        assert_eq!(Theme::worker("PRODUCT_MANAGER"), Theme::worker("product_manager"));
    }

    #[test]
    fn roles_that_used_to_collide_now_have_distinct_colours() {
        // product_manager and data_scientist both fell on GREEN before; a
        // reviewer with no entry fell on SECONDARY, which reads as inactive.
        assert_ne!(Theme::worker("product_manager"), Theme::worker("data_scientist"));
        assert_ne!(Theme::worker("verifier"), Theme::worker("data_scientist"));
        // spider used to share frontend's cyan and scout shared data's green.
        assert_ne!(Theme::worker("spider"), Theme::worker("frontend"));
        assert_ne!(Theme::worker("scout"), Theme::worker("data_scientist"));
        for role in ["forensic", "librarian", "scout", "spider", "tool"] {
            assert_ne!(Theme::worker(role), SECONDARY, "{role} cae en texto apagado");
        }
    }

    #[test]
    fn every_known_role_has_a_colour_of_its_own() {
        // Guards against adding a role without giving it a tone: an unlisted
        // role silently degrades to SECONDARY, which reads as inactive.
        let roles = [
            "bee", "product_manager", "architecture", "backend", "frontend",
            "data_scientist", "security", "test", "devops", "verifier",
            "reviewer", "quality", "forensic", "librarian", "spider", "scout",
            "tool", "tool_worker",
        ];
        for role in roles {
            assert_ne!(Theme::worker(role), SECONDARY, "{role} sin color propio");
        }
    }

    #[test]
    fn the_fused_quality_role_keeps_the_gate_colour() {
        assert_eq!(Theme::worker("verifier"), Theme::worker("reviewer"));
        assert_eq!(Theme::worker("quality"), Theme::worker("verifier"));
    }
}
