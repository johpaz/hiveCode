use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, List, ListItem},
    Frame,
};

use crate::app::{AppState, AMBER, SECONDARY};

const POPUP_BG: Color = Color::Indexed(235);

/// Renders the command suggestion popup as a centered overlay.
/// `area` is the full frame area.
pub fn draw(frame: &mut Frame, state: &mut AppState, area: Rect) {
    if !state.show_popup || state.suggestions.is_empty() {
        return;
    }

    let max_visible = 15;
    let count = state.suggestions.len().min(max_visible) as u16;
    let popup_height = (count + 2).min(area.height.saturating_sub(4)).max(5);
    let popup_width = state
        .suggestions
        .iter()
        .map(|s| s.len() as u16 + 8)
        .max()
        .unwrap_or(40)
        .max(40)
        .min(area.width.saturating_sub(4))
        .min(60);

    // Center the popup
    let x = (area.width.saturating_sub(popup_width)) / 2;
    let y = (area.height.saturating_sub(popup_height)) / 2;

    let popup_area = Rect {
        x,
        y,
        width: popup_width,
        height: popup_height,
    };

    state.popup_area = Some(popup_area);

    frame.render_widget(Clear, popup_area);

    let items: Vec<ListItem> = state.suggestions
        .iter()
        .take(max_visible)
        .enumerate()
        .map(|(i, cmd)| {
            let selected = i == state.popup_sel;
            let selector = if selected { "▸ " } else { "  " };
            let (fg, bg) = if selected {
                (AMBER, Color::Indexed(238))
            } else {
                (SECONDARY, POPUP_BG)
            };
            let style = Style::default()
                .fg(fg)
                .bg(bg)
                .add_modifier(if selected { Modifier::BOLD } else { Modifier::empty() });
            ListItem::new(Line::from(vec![
                Span::styled(selector.to_string(), style),
                Span::styled(cmd.clone(), style),
            ]))
        })
        .collect();

    let block = Block::default()
        .title(Span::styled(" Comandos ", Style::default().fg(AMBER).bg(POPUP_BG).add_modifier(Modifier::BOLD)))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(AMBER))
        .style(Style::default().bg(POPUP_BG));

    let list = List::new(items)
        .block(block)
        .style(Style::default().bg(POPUP_BG));
    frame.render_widget(list, popup_area);
}
