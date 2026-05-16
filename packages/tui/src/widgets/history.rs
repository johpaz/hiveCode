use ratatui::{
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{List, ListItem, ListState},
    Frame,
};

use crate::app::{AppState, HistoryEntry, Role, AMBER, CYAN, DIM, GREEN, RED, SECONDARY};

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let width = area.width as usize;

    let items: Vec<ListItem> = state
        .history
        .iter()
        .flat_map(|entry| entry_to_items(entry, width))
        .collect();

    let list = List::new(items);
    let mut list_state = ListState::default();
    // Always scroll to the last item
    if !state.history.is_empty() {
        list_state.select(Some(
            state
                .history
                .iter()
                .flat_map(|e| entry_to_items(e, width))
                .count()
                .saturating_sub(1),
        ));
    }

    frame.render_stateful_widget(list, area, &mut list_state);
}

fn entry_to_items(entry: &HistoryEntry, width: usize) -> Vec<ListItem<'static>> {
    let (prefix, prefix_color) = match entry.role {
        Role::User => ("▸ tú ", AMBER),
        Role::Assistant => ("⬢ bee ", GREEN),
        Role::System => {
            let is_error = entry.content.starts_with("(×ᴗ×)");
            ("⬡ sys ", if is_error { RED } else { DIM })
        }
        Role::Shell => ("$ ", AMBER),
        Role::Thinking => ("🐝 ", CYAN),
    };

    let prefix_span = Span::styled(prefix, Style::default().fg(prefix_color));
    let indent_span = Span::raw("      ");
    let prefix_len = prefix.len();
    let indent_len = 6; // "      ".len()

    let mut items = Vec::new();

    if entry.content.contains('\n') {
        for (i, line) in entry.content.lines().enumerate() {
            let line_str = line.to_string();
            let trimmed = line_str.trim_start();
            let content_style = if trimmed.starts_with('▸') {
                Style::default().fg(AMBER)
            } else if trimmed.starts_with('·') {
                Style::default().fg(SECONDARY)
            } else if trimmed.starts_with('─') || trimmed.starts_with('═') {
                Style::default().fg(DIM)
            } else {
                Style::default()
            };

            let available_width = if i == 0 {
                width.saturating_sub(prefix_len)
            } else {
                width.saturating_sub(indent_len)
            };

            let wrapped = textwrap::wrap(&line_str, available_width.max(10));

            for (j, wrapped_line) in wrapped.into_iter().enumerate() {
                let content_span = Span::styled(wrapped_line.into_owned(), content_style);
                let line_content = if i == 0 && j == 0 {
                    Line::from(vec![prefix_span.clone(), content_span])
                } else {
                    Line::from(vec![indent_span.clone(), content_span])
                };
                items.push(ListItem::new(line_content));
            }
        }
    } else {
        let content = entry.content.clone();
        let content_style = if entry.role == Role::System && entry.content.starts_with("(×ᴗ×)") {
            Style::default().fg(RED)
        } else {
            Style::default()
        };

        let available_width = width.saturating_sub(prefix_len);
        let wrapped = textwrap::wrap(&content, available_width.max(10));

        for (j, wrapped_line) in wrapped.into_iter().enumerate() {
            let content_span = Span::styled(wrapped_line.into_owned(), content_style);
            let line_content = if j == 0 {
                Line::from(vec![prefix_span.clone(), content_span])
            } else {
                Line::from(vec![indent_span.clone(), content_span])
            };
            items.push(ListItem::new(line_content));
        }
    }

    // Add a blank line between entries for readability
    items.push(ListItem::new(Line::from("")));

    items
}
