use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};
use std::time::Duration;

use crate::app::{AppState, AMBER, DIM, GREEN, SECONDARY};

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let hints = ["/help", "  /logs", "  /provider", "  /mode", "  [ctrl+p] fases", "  [ctrl+m] liberar  [ctrl+k] copiar"];
    let spans: Vec<Span> = hints
        .iter()
        .map(|h| Span::styled(*h, Style::default().fg(DIM)))
        .collect();

    // Copy mode indicator
    if state.copy_mode {
        let msg = "Modo copia: ↑↓ navegar · Enter copiar · Esc salir";
        let line = Line::from(vec![
            Span::styled(
                format!("{:width$}", msg, width = area.width as usize),
                Style::default().fg(AMBER).add_modifier(Modifier::BOLD),
            ),
        ]);
        frame.render_widget(Paragraph::new(line), area);
        return;
    }

    // Clipboard feedback — show for 2 seconds after Ctrl+Y
    if let Some((ref msg, instant)) = state.clipboard_feedback {
        if instant.elapsed() < Duration::from_secs(2) {
            let color = if msg.starts_with('✅') { GREEN } else { AMBER };
            let line = Line::from(vec![
                Span::styled(
                    format!("{:width$}", msg, width = area.width as usize),
                    Style::default().fg(color),
                ),
            ]);
            frame.render_widget(Paragraph::new(line), area);
            return;
        }
    }

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
