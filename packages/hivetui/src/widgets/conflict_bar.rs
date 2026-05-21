use crate::{
    state::AppState,
    term::{Canvas, Color, Rect, Style, BG_CONFLICT, RED},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 || state.conflicts.entries.is_empty() {
        return;
    }
    let conflict = &state.conflicts.entries[0];
    let row = area.y;

    // fondo rojo oscuro
    canvas.fill_rect(
        area,
        ' ',
        Style::new().fg(RED).bg(BG_CONFLICT),
    );

    let msg = format!("⚠  {} · {}", conflict.agent, conflict.path);
    canvas.print(area.x + 1, row, &msg, Style::new().fg(RED).bold());

    // razón (más tenue) si hay espacio
    if !conflict.reason.is_empty() {
        let reason_x = area.x + 1 + msg.chars().count() as u16 + 2;
        let avail = area.right().saturating_sub(reason_x + 12) as usize;
        if avail > 4 {
            let shown: String = conflict.reason.chars().take(avail).collect();
            canvas.print(
                reason_x,
                row,
                &shown,
                Style::new().fg(Color::Rgb { r: 180, g: 80, b: 80 }),
            );
        }
    }

    let tag = "[CRITICAL]";
    let tag_x = area.right().saturating_sub(tag.chars().count() as u16 + 1);
    canvas.print(tag_x, row, tag, Style::new().fg(RED).bold());
}
