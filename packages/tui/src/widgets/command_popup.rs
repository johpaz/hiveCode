use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, List, ListItem},
    Frame,
};

use crate::app::{AppState, AMBER, SECONDARY};

/// Renders the command suggestion popup above the input area.
/// `footer_area` is the area of the footer region (input + statusbar).
pub fn draw(frame: &mut Frame, state: &mut AppState, footer_area: Rect) {
    if !state.show_popup || state.suggestions.is_empty() {
        return;
    }

    let count = state.suggestions.len() as u16;
    let popup_height = count + 2; // items + borders
    let popup_width = state
        .suggestions
        .iter()
        .map(|s| s.len() as u16 + 6) // padding + selector
        .max()
        .unwrap_or(30)
        .max(36)
        .min(footer_area.width.saturating_sub(4));

    // Position popup above the footer
    let y = footer_area.y.saturating_sub(popup_height);
    let x = 2;

    let popup_area = Rect {
        x,
        y,
        width: popup_width,
        height: popup_height,
    };

    // Store for mouse hit-testing
    state.popup_area = Some(popup_area);

    // Clear background
    frame.render_widget(Clear, popup_area);

    // Build list items
    let items: Vec<ListItem> = state
        .suggestions
        .iter()
        .enumerate()
        .map(|(i, cmd)| {
            let selected = i == state.popup_sel;
            let selector = if selected { "▸ " } else { "  " };
            let style = if selected {
                Style::default()
                    .fg(AMBER)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(SECONDARY)
            };
            ListItem::new(Line::from(vec![
                Span::styled(selector.to_string(), style),
                Span::styled(cmd.clone(), style),
            ]))
        })
        .collect();

    let block = Block::default()
        .title(Span::styled(" Comandos ", Style::default().fg(AMBER).add_modifier(Modifier::BOLD)))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(AMBER));

    let list = List::new(items).block(block);
    frame.render_widget(list, popup_area);
}
