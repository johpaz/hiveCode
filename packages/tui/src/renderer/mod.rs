/// Available TUI layouts.  The `run` loop selects one based on the `--screen` flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Layout {
    /// Default conversational REPL view.
    Plan,
    /// Code-focused view (future: diff pane + workers panel).
    Code,
    /// Review layout: history + thought-stream side-by-side.
    Review,
    /// Focus layout: full-screen history only.
    Focus,
    /// Dashboard: workers + file-map + checkpoint timeline.
    Dashboard,
}

impl Layout {
    pub fn from_screen(screen: &str) -> Self {
        match screen {
            "code"      => Layout::Code,
            "review"    => Layout::Review,
            "focus"     => Layout::Focus,
            "dashboard" => Layout::Dashboard,
            _           => Layout::Plan,
        }
    }
}

/// Render the full frame for the given layout.
/// Delegates to the existing `screens` module so the actual widget logic doesn't move yet.
pub fn render(frame: &mut ratatui::Frame, state: &mut crate::app::AppState, layout: &Layout) {
    match layout {
        Layout::Plan | Layout::Code | Layout::Review | Layout::Focus => {
            crate::screens::repl::draw(frame, state);
        }
        Layout::Dashboard => {
            crate::screens::repl::draw(frame, state);
        }
    }
}
