use crate::app::AppState;
use crate::term::{Canvas, Color, Rect, Style, AMBER, DIM, GREEN, RED, SECONDARY};

pub fn draw(canvas: &mut Canvas, state: &AppState, rect: Rect) {
    if rect.h == 0 { return; }
    canvas.draw_border(rect, Style::new().fg(DIM));

    let inner = Rect::new(rect.x + 1, rect.y + 1, rect.w.saturating_sub(2), rect.h.saturating_sub(2));
    let title = " Logs ";
    canvas.print(rect.x + 1, rect.y, title, Style::new().fg(AMBER));

    let max_rows = inner.h as usize;
    let entries  = &state.log_entries;
    let start    = entries.len().saturating_sub(max_rows);

    for (i, entry) in entries[start..].iter().enumerate() {
        let y = inner.y + i as u16;
        if y >= inner.bottom() { break; }

        let level_color = match entry.level.as_str() {
            "error" | "ERROR" => RED,
            "warn"  | "WARN"  => Color::Rgb(252, 211, 77),
            "info"  | "INFO"  => GREEN,
            _                 => DIM,
        };

        let prefix = format!("[{}] ", &entry.level[..entry.level.len().min(4)]);
        canvas.print(inner.x, y, &prefix, Style::new().fg(level_color));
        let msg_x = inner.x + prefix.chars().count() as u16;
        let max_msg = inner.w.saturating_sub(prefix.chars().count() as u16) as usize;
        let msg = if entry.message.len() > max_msg { &entry.message[..max_msg] } else { &entry.message };
        canvas.print(msg_x, y, msg, Style::new().fg(SECONDARY));
    }
}
