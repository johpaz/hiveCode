use ratatui::{
    layout::{Alignment, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::app::AppState;

const COORDINATOR_COLORS: &[(&str, Color)] = &[
    ("bee", Color::Indexed(214)),          // amber
    ("architecture", Color::Indexed(141)), // purple
    ("backend", Color::Indexed(75)),       // blue
    ("frontend", Color::Indexed(114)),     // green
    ("security", Color::Indexed(203)),     // red
    ("test", Color::Rgb(252, 211, 77)),   // yellow
    ("devops", Color::Indexed(240)),       // gray
];

fn coordinator_color(name: &str) -> Color {
    COORDINATOR_COLORS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, c)| *c)
        .unwrap_or(Color::Gray)
}

fn status_symbol(status: &str) -> &'static str {
    match status {
        "completed" => "⬢",
        "thinking" | "running" => "◉",
        "error" => "✕",
        "blocked" => "⊘",
        _ => "○",
    }
}

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let block = Block::default()
        .title(" Phases ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::DarkGray));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if state.phases.is_empty() {
        let empty = Paragraph::new("No active phases")
            .alignment(Alignment::Center)
            .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(empty, inner);
        return;
    }

    let items: Vec<Line> = state
        .phases
        .iter()
        .map(|phase| {
            let color = coordinator_color(&phase.coordinator);
            let is_active = phase.status == "thinking" || phase.status == "running";
            let sym = status_symbol(&phase.status);

            let mut spans = vec![
                Span::styled(
                    format!("{} ", sym),
                    Style::default()
                        .fg(color)
                        .add_modifier(if is_active { Modifier::BOLD } else { Modifier::empty() }),
                ),
                Span::styled(
                    format!("{:<14} ", phase.coordinator),
                    Style::default()
                        .fg(color)
                        .add_modifier(if is_active { Modifier::BOLD } else { Modifier::empty() }),
                ),
                Span::styled(
                    phase.name.clone(),
                    Style::default().fg(Color::Gray),
                ),
            ];

            if let Some(dur) = phase.duration_ms {
                spans.push(Span::styled(
                    format!("  {:.1}s", dur as f64 / 1000.0),
                    Style::default().fg(Color::DarkGray),
                ));
            }

            Line::from(spans)
        })
        .collect();

    let paragraph = Paragraph::new(items);
    frame.render_widget(paragraph, inner);
}
