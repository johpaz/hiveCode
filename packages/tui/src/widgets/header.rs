use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::app::{AppState, AMBER, DIM, GREEN, SECONDARY};

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Length(1)])
        .split(area);

    // ── Mascot + title (big text) ─────────────────────────────────────────
    let mascot = if state.running { " (~ᴗ~) " } else { " \\(^ᴗ^)/ " };

    let title_line = Line::from(vec![
        Span::styled(mascot, Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::styled(" hivecode ", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)),
        Span::styled(&state.version, Style::default().fg(DIM)),
        Span::styled("  ·  ", Style::default().fg(DIM)),
        Span::styled(&state.project_name, Style::default().fg(SECONDARY)),
    ]);

    frame.render_widget(Paragraph::new(title_line), chunks[0]);

    // ── Subtitle: mode / provider / tokens ───────────────────────────────
    let provider_str = if state.provider.is_empty() {
        "sin provider".to_string()
    } else if state.model.is_empty() {
        state.provider.clone()
    } else {
        format!("{}  ·  {}", state.provider, state.model)
    };

    let subtitle = Line::from(vec![
        Span::styled(
            format!(" {} ", state.mode.label()),
            Style::default().fg(AMBER).add_modifier(Modifier::BOLD),
        ),
        Span::styled("  │  ", Style::default().fg(DIM)),
        Span::styled(
            provider_str,
            Style::default().fg(if state.provider.is_empty() { crate::app::RED } else { GREEN }),
        ),
        Span::styled("  │  ", Style::default().fg(DIM)),
        Span::styled(
            format!("{} tareas", state.task_count),
            Style::default().fg(SECONDARY),
        ),
        Span::styled("  │  ", Style::default().fg(DIM)),
        Span::styled(
            format!("{} tok", state.fmt_tokens()),
            Style::default().fg(DIM),
        ),
        Span::styled("  │  ", Style::default().fg(DIM)),
        Span::styled(
            format!("{} agentes", state.agent_count),
            Style::default().fg(if state.agent_count >= 6 { GREEN } else { crate::app::RED }),
        ),
    ]);

    frame.render_widget(Paragraph::new(subtitle), chunks[1]);
}
