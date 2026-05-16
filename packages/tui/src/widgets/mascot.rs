use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::app::{AppState, MascotState, AMBER, DIM, GREEN, RED};

// Animation frames per state (cycled via animation_frame % frames.len())
const THINKING_FRAMES:  &[&str] = &["(~•~)", "(~-~)", "(~•~)", "(>•<)"];
const SEARCHING_FRAMES: &[&str] = &["(o•-)", "(-•o)", "(o•-)", "(-•-)"];
const READING_FRAMES:   &[&str] = &["(^•^)", "(^-^)", "(^•^)", "(^_^)"];
const WRITING_FRAMES:   &[&str] = &["(>•<)", "(>-<)", "(>•<)", "(>•.)"];
const EXECUTING_FRAMES: &[&str] = &["(•ᴗ•)", "(•ᴗ-)", "(-ᴗ•)", "(•ᴗ•)"];

/// Renders an animated bee mascot in the bottom-right corner.
pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let fi = state.animation_frame as usize;

    let (face, color) = match state.mascot_state {
        MascotState::Welcome   => ("\\(^•^)/", AMBER),
        MascotState::Thinking  => (THINKING_FRAMES[fi % THINKING_FRAMES.len()], state.coordinator_color()),
        MascotState::Searching => (SEARCHING_FRAMES[fi % SEARCHING_FRAMES.len()], Color::Rgb(96, 165, 250)),
        MascotState::Reading   => (READING_FRAMES[fi % READING_FRAMES.len()], Color::Rgb(167, 243, 208)),
        MascotState::Writing   => (WRITING_FRAMES[fi % WRITING_FRAMES.len()], Color::Rgb(196, 181, 253)),
        MascotState::Executing => (EXECUTING_FRAMES[fi % EXECUTING_FRAMES.len()], Color::Rgb(252, 211, 77)),
        MascotState::Completed => ("(★•★)", GREEN),
        MascotState::Error     => ("(x•x)", RED),
        MascotState::Idle      => ("(-•-)", DIM),
        MascotState::PlanMode  => ("(o•o)", Color::Rgb(196, 181, 253)),
        MascotState::Approval  => ("(?•?)", Color::Rgb(252, 211, 77)),
    };

    let style = Style::default()
        .fg(color)
        .add_modifier(Modifier::BOLD);

    let line = Line::from(vec![Span::styled(face, style)]);

    let text_width = face.chars().count() as u16;
    let width = text_width + 2;
    let x = area.x + area.width.saturating_sub(width + 1);
    let y = area.y + area.height.saturating_sub(1);

    let mascot_area = Rect {
        x: x.min(area.x + area.width.saturating_sub(width)),
        y,
        width: width.min(area.width),
        height: 1,
    };

    frame.render_widget(Paragraph::new(line), mascot_area);
}
