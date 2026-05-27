use crate::{
    state::{AppState, ModalState},
    term::{Canvas, Rect, Style, AMBER, DIM, GREEN, RED, SECONDARY, WHITE, BG_ELEVATED},
};

const OPTIONS: &[(&str, &str, &str)] = &[
    ("⚡", "Ejecutar automáticamente",  "El plan se implementa sin pausas intermedias"),
    ("🔍", "Aprobar fase por fase",      "Cada coordinador requiere tu aprobación antes de continuar"),
    ("💬", "Agregar contexto",           "Escribe instrucciones adicionales antes de ejecutar"),
    ("✗",  "Cancelar plan",             "Descarta el plan y vuelve al input"),
];

pub fn render(canvas: &mut Canvas, full_area: Rect, state: &AppState) {
    let ModalState::PlanApproval(modal) = &state.modal else {
        return;
    };

    let modal_w = (full_area.w.saturating_sub(8)).min(72).max(50);
    let modal_h = 14u16;
    let modal_x = full_area.x + (full_area.w.saturating_sub(modal_w)) / 2;
    let modal_y = full_area.y + (full_area.h.saturating_sub(modal_h)) / 2;
    let area = Rect { x: modal_x, y: modal_y, w: modal_w, h: modal_h };

    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    canvas.draw_border(area, Style::new().fg(AMBER));
    canvas.print_centered(area.x, area.y, area.w, " ⬡ APROBACIÓN DEL PLAN ", Style::new().fg(AMBER).bold());

    for (i, (icon, label, desc)) in OPTIONS.iter().enumerate() {
        let y = area.y + 2 + (i as u16) * 2;
        let is_selected = i == modal.selected;

        if is_selected {
            // Highlight row
            let row_rect = Rect { x: area.x + 1, y, w: area.w - 2, h: 1 };
            canvas.fill_rect(row_rect, ' ', Style::new().fg(WHITE).bold());
            canvas.print(area.x + 2, y, "▶ ", Style::new().fg(AMBER).bold());
            canvas.print(area.x + 4, y, icon, Style::new().fg(AMBER).bold());
            canvas.print(area.x + 4 + icon.len() as u16 + 1, y, label, Style::new().fg(WHITE).bold());
        } else {
            canvas.print(area.x + 4, y, icon, Style::new().fg(DIM));
            canvas.print(area.x + 4 + icon.len() as u16 + 1, y, label, Style::new().fg(SECONDARY));
        }

        // Description on next line
        canvas.print(area.x + 6, y + 1, desc, Style::new().fg(DIM));
    }

    let hint_y = area.bottom().saturating_sub(1);
    canvas.print(area.x + 2, hint_y, "↑↓ navegar", Style::new().fg(DIM));
    canvas.print(area.x + 14, hint_y, "·", Style::new().fg(DIM));
    canvas.print(area.x + 16, hint_y, "↩ seleccionar", Style::new().fg(GREEN));
    canvas.print(area.x + 31, hint_y, "·", Style::new().fg(DIM));
    canvas.print(area.x + 33, hint_y, "Esc cancelar", Style::new().fg(RED));
}
