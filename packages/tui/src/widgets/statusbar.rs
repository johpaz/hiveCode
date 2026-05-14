use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::app::{AppState, AMBER, DIM, SECONDARY};

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let hints = ["/help", "  /provider", "  /mode", "  /telegram", "  [shift+tab] modo"];
    let spans: Vec<Span> = hints
        .iter()
        .map(|h| Span::styled(*h, Style::default().fg(DIM)))
        .collect();

    // Right side: status message
    let status = if state.activity_status == "idle" || state.active_coordinator.is_empty() {
        Span::styled(
            format!("  {}  ", state.status_msg),
            Style::default().fg(if state.running { AMBER } else { SECONDARY }),
        )
    } else {
        // Activity indicator: show coordinator + phase
        let indicator = "◉";
        let text = if !state.active_phase.is_empty() {
            format!(
                "  {} {}: {}  ",
                indicator, state.active_coordinator, state.active_phase
            )
        } else {
            format!("  {} {}  ", indicator, state.active_coordinator)
        };
        Span::styled(
            text,
            Style::default()
                .fg(AMBER)
                .add_modifier(Modifier::BOLD),
        )
    };

    let line = Line::from({
        let mut all = spans;
        all.push(status);
        all
    });

    frame.render_widget(Paragraph::new(line), area);
}
