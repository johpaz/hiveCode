use crate::app::{AppState, HistoryEntry, Role};
use crate::term::{Canvas, Color, Rect, Style, AMBER, BLUE, CYAN, DIM, GREEN, RED};
use crate::markdown::{render_content, Segment};

pub fn draw(canvas: &mut Canvas, state: &mut AppState, rect: Rect) {
    if rect.h == 0 || rect.w == 0 { return; }
    let width = rect.w as usize;

    // Renderizar cada entrada del historial como líneas de segmentos
    let mut all_lines: Vec<Vec<Segment>> = Vec::new();
    for entry in &state.history {
        let (prefix, prefix_color, indent): (&str, Color, &str) = match entry.role {
            Role::User      => ("▸ ", AMBER,  "  "),
            Role::Assistant => ("  ", GREEN,  "  "),
            Role::System    => ("⚙ ", CYAN,   "  "),
            Role::Shell     => ("$ ", BLUE,   "  "),
            Role::Thinking  => ("… ", DIM,    "  "),
        };
        let lines = render_content(
            &entry.content,
            &entry.content_type,
            &entry.thinking_meta,
            width.saturating_sub(2),
            prefix,
            Style::new().fg(prefix_color),
            indent,
        );
        all_lines.extend(lines);
    }

    // Scroll: mostrar las últimas N líneas que caben en el rect
    let visible_rows = rect.h as usize;
    let total        = all_lines.len();
    let start        = total.saturating_sub(visible_rows);

    for (i, line) in all_lines[start..].iter().enumerate() {
        let y  = rect.y + i as u16;
        let mut x = rect.x;
        for seg in line {
            if x >= rect.right() { break; }
            canvas.print(x, y, &seg.text, seg.style);
            x += seg.text.chars().count() as u16;
        }
    }
}

/// Retorna todo el historial como texto plano (para copiar al portapapeles).
pub fn get_text(history: &[HistoryEntry]) -> String {
    history.iter().map(|e| format!("[{}] {}\n", role_label(&e.role), e.content)).collect()
}

fn role_label(role: &Role) -> &'static str {
    match role {
        Role::User      => "user",
        Role::Assistant => "assistant",
        Role::System    => "system",
        Role::Shell     => "shell",
        Role::Thinking  => "thinking",
    }
}
