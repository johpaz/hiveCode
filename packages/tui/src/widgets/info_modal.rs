use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, Paragraph},
    Frame,
};

use crate::app::{AppState, AMBER, DIM, SECONDARY};

pub fn draw(frame: &mut Frame, state: &AppState) {
    if !state.show_info_modal {
        return;
    }

    let area = frame.area();

    // Modal dimensions: 60% width, height based on content
    let content_lines = state.info_modal_content.lines().count() as u16;
    let modal_width = (area.width * 6 / 10).max(50).min(area.width.saturating_sub(4));
    let modal_height = (content_lines + 4).min(area.height.saturating_sub(4)).max(10);

    let x = (area.width.saturating_sub(modal_width)) / 2;
    let y = (area.height.saturating_sub(modal_height)) / 2;

    let modal_area = Rect { x, y, width: modal_width, height: modal_height };

    frame.render_widget(Clear, modal_area);

    let outer_block = Block::default()
        .title(Span::styled(
            format!(" {} ", state.info_modal_title),
            Style::default().fg(AMBER).add_modifier(Modifier::BOLD),
        ))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(AMBER));

    frame.render_widget(outer_block, modal_area);

    // Inner area (inside the border)
    let inner = Rect {
        x: modal_area.x + 1,
        y: modal_area.y + 1,
        width: modal_area.width.saturating_sub(2),
        height: modal_area.height.saturating_sub(2),
    };

    // Split inner into content area and hint line
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(inner);

    // Content paragraph with scroll
    let lines: Vec<Line> = state.info_modal_content
        .lines()
        .skip(state.info_scroll_offset)
        .map(|l| Line::from(Span::styled(l.to_string(), Style::default().fg(SECONDARY))))
        .collect();

    let content_para = Paragraph::new(lines);

    frame.render_widget(content_para, chunks[0]);

    // Hint line
    let hint_area = chunks[1];
    let hint = Line::from(vec![
        Span::styled("  ", Style::default().fg(DIM)),
        Span::styled("Esc", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::styled(" cerrar  ", Style::default().fg(DIM)),
        Span::styled("↑↓", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::styled(" scroll", Style::default().fg(DIM)),
    ]);
    frame.render_widget(Paragraph::new(hint), hint_area);
}
