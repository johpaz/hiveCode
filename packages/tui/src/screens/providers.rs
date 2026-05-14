use ratatui::{
    layout::{Constraint, Direction, Layout},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Cell, Paragraph, Row, Table, TableState},
    Frame,
};

use crate::app::{AppState, AMBER, DIM, GREEN};

pub fn draw(frame: &mut Frame, state: &AppState) {
    let area = frame.area();

    let root = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),  // header
            Constraint::Fill(1),    // table
            Constraint::Length(1),  // hints
        ])
        .split(area);

    // ── Header ────────────────────────────────────────────────────────────
    let header_line = Line::from(vec![
        Span::styled(" Providers LLM ", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::styled("  │  ", Style::default().fg(DIM)),
        Span::styled(
            format!(
                "Default: {}",
                if state.provider.is_empty() { "—" } else { &state.provider }
            ),
            Style::default().fg(GREEN),
        ),
    ]);
    frame.render_widget(Paragraph::new(header_line), root[0]);

    // ── Table placeholder (Phase 3 populates with provider rows) ─────────
    let col_headers = Row::new(vec![
        Cell::from("Est").style(Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Cell::from("ID").style(Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Cell::from("Nombre").style(Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Cell::from("Modelo").style(Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Cell::from("URL").style(Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
    ]);

    let table = Table::new(
        vec![Row::new(vec![
            Cell::from("—"),
            Cell::from("(vacío)"),
            Cell::from(""),
            Cell::from(""),
            Cell::from(""),
        ])],
        [
            Constraint::Length(4),
            Constraint::Fill(1),
            Constraint::Fill(2),
            Constraint::Fill(2),
            Constraint::Fill(3),
        ],
    )
    .header(col_headers)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(DIM)),
    );

    let mut table_state = TableState::default();
    frame.render_stateful_widget(table, root[1], &mut table_state);

    // ── Hints ─────────────────────────────────────────────────────────────
    let hints = Line::from(vec![
        Span::styled(" s ", Style::default().fg(AMBER)),
        Span::styled("set-default", Style::default().fg(DIM)),
        Span::styled("  d ", Style::default().fg(AMBER)),
        Span::styled("eliminar", Style::default().fg(DIM)),
        Span::styled("  a ", Style::default().fg(AMBER)),
        Span::styled("añadir", Style::default().fg(DIM)),
        Span::styled("  q ", Style::default().fg(AMBER)),
        Span::styled("salir", Style::default().fg(DIM)),
    ]);
    frame.render_widget(Paragraph::new(hints), root[2]);
}
