use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, BG_CONFLICT, RED},
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

    // Construir partes del mensaje
    let agents = format!("{} ↔ {}", conflict.agent_a, conflict.agent_b);
    let mut parts = vec![agents, conflict.path.clone(), conflict.reason.clone()];
    if let Some(ref detail) = conflict.detail {
        parts.push(detail.clone());
    }
    let msg = parts.join(" | ");

    canvas.print(area.x + 1, row, &msg, Style::new().fg(RED).bold());

    // Tag de severidad a la derecha
    let tag = format!("[{}]", conflict.severity.to_uppercase());
    let tag_x = area.right().saturating_sub(tag.chars().count() as u16 + 1);
    if tag_x > area.x + 1 + msg.chars().count() as u16 {
        canvas.print(tag_x, row, &tag, Style::new().fg(RED).bold());
    }
}
