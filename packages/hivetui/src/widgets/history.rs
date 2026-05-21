use crate::{
    state::{AppState, Role},
    term::{Canvas, Rect, Style, AMBER, DIM, GREEN, SECONDARY},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.draw_border(area, Style::new().fg(AMBER));
    canvas.print(area.x + 2, area.y, "historial", Style::new().fg(AMBER).bold());

    if state.history.entries.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "Historial vacio", Style::new().fg(DIM).dim());
        return;
    }

    let content_width = area.w.saturating_sub(4) as usize;
    let max_rows = area.h.saturating_sub(2) as usize;
    let (lines, first_line_for_entry) = build_wrapped_lines(state, content_width.saturating_sub(2));
    let total = lines.len();
    let selected_entry = selected_entry_index(state);
    let start = visible_start_for_selection(total, max_rows, selected_entry, &first_line_for_entry);

    for (row, (entry_idx, line)) in lines[start..].iter().take(max_rows).enumerate() {
        let y = area.y + 1 + row as u16;
        let is_selected = *entry_idx == selected_entry;
        let style = if is_selected {
            Style::new().fg(AMBER).bold()
        } else if line.starts_with('▸') || line.starts_with('⚙') || line.starts_with('$') || line.starts_with('…') {
            Style::new().fg(GREEN)
        } else {
            Style::new()
        };
        let clipped = clip_line(line, state.history_hscroll, content_width.saturating_sub(3));
        if is_selected {
            canvas.print(area.x + 2, y, ">", Style::new().fg(AMBER).bold());
            canvas.print(area.x + 4, y, &clipped, style);
        } else {
            canvas.print(area.x + 2, y, " ", Style::new());
            canvas.print(area.x + 4, y, &clipped, style);
        }
    }

    if total > max_rows && max_rows > 0 {
        let scrollbar_x = area.right().saturating_sub(2);
        let track_top = area.y + 1;
        let track_h = area.h.saturating_sub(2);
        for i in 0..track_h {
            canvas.print(scrollbar_x, track_top + i, "│", Style::new().fg(DIM));
        }

        let thumb_h = ((max_rows * max_rows).max(1) / total).max(1) as u16;
        let thumb_start = ((start * max_rows) / total) as u16;
        for i in 0..thumb_h.min(track_h) {
            let y = track_top + (thumb_start + i).min(track_h.saturating_sub(1));
            canvas.print(scrollbar_x, y, "█", Style::new().fg(SECONDARY));
        }
    }
}

pub fn entry_at_y(state: &AppState, area: Rect, y: u16) -> Option<usize> {
    if state.history.entries.is_empty() || y <= area.y || y >= area.bottom().saturating_sub(1) {
        return None;
    }

    let content_width = area.w.saturating_sub(4) as usize;
    let max_rows = area.h.saturating_sub(2) as usize;
    let (lines, first_line_for_entry) = build_wrapped_lines(state, content_width.saturating_sub(2));
    if lines.is_empty() || max_rows == 0 {
        return None;
    }

    let total = lines.len();
    let selected_entry = selected_entry_index(state);
    let start = visible_start_for_selection(total, max_rows, selected_entry, &first_line_for_entry);
    let row = y.saturating_sub(area.y + 1) as usize;
    let idx = start.saturating_add(row);
    lines.get(idx).map(|(entry_idx, _)| *entry_idx)
}

fn selected_entry_index(state: &AppState) -> usize {
    state
        .history
        .selected
        .unwrap_or_else(|| state.history.entries.len().saturating_sub(1))
}

fn visible_start_for_selection(
    total: usize,
    max_rows: usize,
    selected_entry: usize,
    first_line_for_entry: &[usize],
) -> usize {
    let selected_line = first_line_for_entry
        .get(selected_entry)
        .copied()
        .unwrap_or(total.saturating_sub(1));
    if max_rows == 0 || total <= max_rows {
        0
    } else {
        selected_line
            .saturating_sub(max_rows.saturating_sub(1))
            .min(total - max_rows)
    }
}

fn build_wrapped_lines(state: &AppState, width: usize) -> (Vec<(usize, String)>, Vec<usize>) {
    let mut lines: Vec<(usize, String)> = Vec::new();
    let mut first_line_for_entry: Vec<usize> = Vec::with_capacity(state.history.entries.len());

    for (entry_idx, entry) in state.history.entries.iter().enumerate() {
        first_line_for_entry.push(lines.len());
        let prefix = match entry.role {
            Role::User => "▸ usuario",
            Role::Assistant => "  asistente",
            Role::System => "⚙ sistema",
            Role::Shell => "$ shell",
            Role::Thinking => "… thinking",
        };
        let content_lines: Vec<&str> = entry.content.lines().collect();
        let content_lines = if content_lines.is_empty() { vec![""] } else { content_lines };
        for (i, content_line) in content_lines.iter().enumerate() {
            let head = if i == 0 {
                format!("{prefix} {content_line}")
            } else {
                format!("   {content_line}")
            };
            for chunk in wrap_line(&head, width) {
                lines.push((entry_idx, chunk));
            }
        }
    }

    (lines, first_line_for_entry)
}

fn wrap_line(input: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }

    let chars: Vec<char> = input.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;

    while i < chars.len() {
        let end = (i + width).min(chars.len());
        let chunk: String = chars[i..end].iter().collect();
        out.push(chunk);
        i = end;
    }

    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn clip_line(input: &str, offset: usize, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    input.chars().skip(offset).take(width).collect()
}
