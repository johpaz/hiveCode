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

    // Calculate inner width (minus borders) to right-align mascot
    let inner_width = (area.width as usize).saturating_sub(2);
    let text_width = before.chars().count() + 1 + after.chars().count();
    let mascot_width = mascot.chars().count();
    let padding = inner_width.saturating_sub(text_width + mascot_width);
    let spaces = " ".repeat(padding);

    let line = Line::from(vec![
        Span::raw(before),
        Span::styled(at, cursor_style),
        Span::raw(after),
        Span::raw(spaces),
        Span::styled(mascot, mascot_style),
    ]);

    let paragraph = Paragraph::new(line).block(block);
    frame.render_widget(paragraph, area);
}
