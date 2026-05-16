use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

use crate::app::{AppState, LogEntry, AMBER, DIM, GREEN, RED, SECONDARY};

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let block = Block::default()
        .title(" Logs ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(DIM));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if state.log_entries.is_empty() {
        let empty = Paragraph::new("Esperando logs...")
            .style(Style::default().fg(DIM))
            .wrap(Wrap { trim: true });
        frame.render_widget(empty, inner);
        return;
    }

    let lines: Vec<Line> = state
        .log_entries
        .iter()
        .rev()
        .take(inner.height as usize)
        .rev()
        .map(|entry| format_log_line(entry))
        .collect();

    let paragraph = Paragraph::new(lines)
        .wrap(Wrap { trim: true })
        .scroll((state.log_entries.len().saturating_sub(inner.height as usize) as u16, 0));

    frame.render_widget(paragraph, inner);
}

fn format_log_line(entry: &LogEntry) -> Line<'_> {
    let color = match entry.level.as_str() {
        "error" => RED,
        "warn" => AMBER,
        "debug" => SECONDARY,
        _ => GREEN,
    };

    let ts = if entry.timestamp.len() >= 19 {
        &entry.timestamp[11..19]
    } else {
        &entry.timestamp
    };

    Line::from(vec![
        Span::styled(
            format!("{} ", ts),
            Style::default().fg(DIM),
        ),
        Span::styled(
            format!("{} ", entry.level.to_uppercase()),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("[{}] {}", entry.source, entry.message),
            Style::default().fg(SECONDARY),
        ),
    ])
}
