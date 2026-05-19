use ratatui::{
    layout::Rect,
    widgets::{List, ListItem, ListState},
    Frame,
};

use crate::app::{AppState, HistoryEntry, Role, AMBER, CYAN, DIM, GREEN, RED, BLUE};
use crate::markdown;

pub fn get_text(history: &[HistoryEntry]) -> String {
    history
        .iter()
        .map(|e| {
            let label = match e.role {
                Role::User      => "tú",
                Role::Assistant => "bee",
                Role::System    => "sys",
                Role::Shell     => "$",
                Role::Thinking  => "bee (thinking)",
            };
            format!("[{}] {}", label, e.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn draw(frame: &mut Frame, state: &AppState, area: Rect) {
    let width = area.width.saturating_sub(2) as usize;

    let items: Vec<ListItem> = state
        .history
        .iter()
        .enumerate()
        .flat_map(|(idx, entry)| entry_to_items(entry, width, state.copy_mode && idx == state.copy_sel))
        .collect();

    let list = List::new(items);
    let mut list_state = ListState::default();
    if !state.history.is_empty() {
        list_state.select(Some(
            state
                .history
                .iter()
                .flat_map(|e| entry_to_items(e, width, false))
                .count()
                .saturating_sub(1),
        ));
    }

    frame.render_stateful_widget(list, area, &mut list_state);
}

fn role_prefix(role: &Role) -> (&'static str, ratatui::style::Color) {
    match role {
        Role::User      => ("▸ tú ", AMBER),
        Role::Assistant => ("⬢ bee ", GREEN),
        Role::System    => ("⬡ sys ", DIM),
        Role::Shell     => ("$ ", AMBER),
        Role::Thinking  => ("🐝 ", CYAN),
    }
}

fn entry_to_items(entry: &HistoryEntry, width: usize, is_selected: bool) -> Vec<ListItem<'static>> {
    let (prefix_str, prefix_color) = role_prefix(&entry.role);
    let prefix_color = if is_selected { BLUE } else { prefix_color };

    // For System role with error prefix, override content color
    if entry.role == Role::System && entry.content.starts_with("(×ᴗ×)") {
        let lines = markdown::render_content(
            &entry.content,
            &entry.content_type,
            &entry.thinking_meta,
            width,
            prefix_str,
            if is_selected { BLUE } else { RED },
            "      ",
        );
        return lines.into_iter().map(ListItem::new).collect();
    }

    // For Thinking role, use the compact thinking indicator
    if entry.role == Role::Thinking {
        let lines = markdown::render_content(
            &entry.content,
            &entry.content_type,
            &entry.thinking_meta,
            width,
            prefix_str,
            prefix_color,
            "      ",
        );
        return lines.into_iter().map(ListItem::new).collect();
    }

    // For Markdown content, use the markdown renderer
    let lines = markdown::render_content(
        &entry.content,
        &entry.content_type,
        &entry.thinking_meta,
        width,
        prefix_str,
        prefix_color,
        "      ",
    );
    lines.into_iter().map(ListItem::new).collect()
}