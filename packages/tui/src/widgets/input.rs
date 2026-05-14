use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph},
    Frame,
};

use crate::app::{AppState, AMBER, DIM};

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let (border_color, title_text) = if state.running {
        (DIM, " Ejecutando… ")
    } else if state.show_popup {
        (AMBER, " ↑↓ navegar · Enter ejecutar · Esc cancelar ")
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

    let mascot = if state.running { " (~ᴗ~) " } else { " (?ᴗ?) " };

    let line = Line::from(vec![
        Span::styled(mascot, Style::default().fg(if state.running { DIM } else { AMBER })),
        Span::raw(before),
        Span::styled(at, cursor_style),
        Span::raw(after),
    ]);

    let paragraph = Paragraph::new(line).block(block);
    frame.render_widget(paragraph, area);
}
