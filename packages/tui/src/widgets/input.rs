use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph},
    Frame,
};

use crate::app::{AppState, MascotState, AMBER, DIM, GREEN, RED};

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let (border_color, title_text) = if state.running {
        (DIM, " Ejecutando… ")
    } else if state.show_popup {
        (AMBER, " ↑↓ navegar · Enter ejecutar · Esc cancelar ")
    } else if state.shell_mode {
        (GREEN, " $ shell mode — Ctrl+X para volver ")
    } else {
        (AMBER, " ¿Qué construirás hoy? (/ para comandos) ")
    };

    let border_style = Style::default().fg(border_color);

    let block = Block::default()
        .title(title_text)
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(border_style);

    // Build display text with cursor
    let value = state.input.value();
    let cursor = state.input.cursor;

    let chars: Vec<char> = value.chars().collect();
    let (before, at, after) = if cursor < chars.len() {
        let b: String = chars[..cursor].iter().collect();
        let a_char = chars[cursor].to_string();
        let a: String = chars[cursor + 1..].iter().collect();
        (b, a_char, a)
    } else {
        (value.clone(), " ".to_string(), String::new())
    };

    let cursor_style = if state.cursor_visible {
        Style::default()
            .fg(ratatui::style::Color::Black)
            .bg(AMBER)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(DIM)
    };

    // Mascot face based on state — positioned at the RIGHT of the input
    let fi = state.animation_frame as usize;
    let (mascot_face, mascot_color) = match state.mascot_state {
        MascotState::Welcome   => ("\\(^•^)/", AMBER),
        MascotState::Thinking  => (["(~•~)", "(~-~)", "(~•~)", "(>•<)"][fi % 4], AMBER),
        MascotState::Searching => (["(o•-)", "(-•o)", "(o•-)", "(-•-)"][fi % 4], ratatui::style::Color::Rgb(96, 165, 250)),
        MascotState::Reading   => (["(^•^)", "(^-^)", "(^•^)", "(^_^)"][fi % 4], ratatui::style::Color::Rgb(167, 243, 208)),
        MascotState::Writing   => (["(>•<)", "(>-<)", "(>•<)", "(>•.)"][fi % 4], ratatui::style::Color::Rgb(196, 181, 253)),
        MascotState::Executing => (["(•v•)", "(•-•)", "(•v•)", "(•_•)"][fi % 4], ratatui::style::Color::Rgb(252, 211, 77)),
        MascotState::Completed => ("(★•★)", GREEN),
        MascotState::Error     => ("(x•x)", RED),
        MascotState::Idle      => ("(-•-)", DIM),
        MascotState::PlanMode  => ("(o•o)", ratatui::style::Color::Rgb(196, 181, 253)),
        MascotState::Approval  => ("(?•?)", ratatui::style::Color::Rgb(252, 211, 77)),
    };
    let mascot = format!(" {} ", mascot_face);
    let mascot_style = Style::default()
        .fg(mascot_color)
        .add_modifier(Modifier::BOLD);

    // Calculate inner width (minus borders)
    let inner_width = (area.width as usize).saturating_sub(2);
    let mascot_width = mascot.chars().count();
    let min_padding = 2; // minimum space between text and mascot
    let max_text_width = inner_width.saturating_sub(mascot_width + min_padding);

    // Build visible text with cursor, truncating from the LEFT if necessary
    let text_width = before.chars().count() + 1 + after.chars().count();
    let (visible_before, visible_at, visible_after, truncated, skip) = if text_width > max_text_width {
        // Truncate from the beginning, keeping cursor visible
        let overflow = text_width - max_text_width;
        // Skip overflow + 1 to account for the "…" character we'll add
        let skip = (overflow + 1).min(before.chars().count());
        let b: String = before.chars().skip(skip).collect();
        // Add ellipsis indicator if we skipped chars
        let b = if skip > 0 { format!("…{}", b) } else { b };
        let a = after.to_string();
        (b, at.to_string(), a, true, skip)
    } else {
        (before.clone(), at.to_string(), after.clone(), false, 0)
    };

    // Recalculate padding with potentially truncated text
    let visible_text_width = visible_before.chars().count() + visible_at.chars().count() + visible_after.chars().count();
    let padding = inner_width.saturating_sub(visible_text_width + mascot_width).max(min_padding);
    let spaces = " ".repeat(padding);

    // Build spans with proper truncation indicator
    let mut spans: Vec<Span> = Vec::new();
    if truncated && skip > 0 {
        // Use char-based slicing to avoid multi-byte panic
        let remaining: String = before.chars().skip(skip).collect();
        spans.push(Span::styled("…", Style::default().fg(DIM)));
        spans.push(Span::raw(remaining));
    } else {
        spans.push(Span::raw(visible_before));
    }
    spans.push(Span::styled(visible_at, cursor_style));
    spans.push(Span::raw(visible_after));
    spans.push(Span::raw(spaces));
    spans.push(Span::styled(mascot, mascot_style));

    let line = Line::from(spans);

    let paragraph = Paragraph::new(line).block(block);
    frame.render_widget(paragraph, area);
}
