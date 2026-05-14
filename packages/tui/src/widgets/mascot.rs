use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::app::{AppState, MascotState, AMBER, DIM, GREEN, RED};

/// Renders a small bee-face mascot in the bottom-right corner.
/// The face changes based on the current session state.
pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let (face, color) = match state.mascot_state {
        MascotState::Welcome   => ("\\(^•^)/", AMBER),
        MascotState::Thinking  => ("(~•~)",    AMBER),
        MascotState::Completed => ("(★•★)",    GREEN),
        MascotState::Error     => ("(x•x)",    RED),
        MascotState::Idle      => ("(-•-)",    DIM),
        MascotState::PlanMode  => ("(o•o)",    Color::Rgb(196, 181, 253)),
        MascotState::Approval  => ("(?•?)",    Color::Rgb(252, 211, 77)),
    };

    let style = Style::default()
        .fg(color)
        .add_modifier(Modifier::BOLD);

    let line = Line::from(vec![Span::styled(face, style)]);

    // Use char count for accurate display width (not byte length)
    let text_width = face.chars().count() as u16;
    let width = text_width + 2; // padding
    let x = area.x + area.width.saturating_sub(width + 1);
    let y = area.y + area.height.saturating_sub(1);

    // Ensure we don't draw outside the frame
    let mascot_area = Rect {
        x: x.min(area.x + area.width.saturating_sub(width)),
        y,
        width: width.min(area.width),
        height: 1,
    };

    frame.render_widget(Paragraph::new(line), mascot_area);
}
