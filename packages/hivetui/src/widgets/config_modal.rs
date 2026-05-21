use crate::{
    state::{AppState, ModalFieldKind, ModalState},
    term::{Canvas, Rect, Style, AMBER, CYAN, DIM, GREEN, SECONDARY},
};

/// Renderiza el modal de configuración centrado en pantalla.
pub fn render(canvas: &mut Canvas, full_area: Rect, state: &AppState) {
    let ModalState::Config(modal) = &state.modal else {
        return;
    };

    let modal_w = (full_area.w.saturating_sub(8)).min(70).max(40);
    let modal_h = (modal.fields.len() as u16 * 3 + 6).min(full_area.h.saturating_sub(4));
    let modal_x = full_area.x + (full_area.w.saturating_sub(modal_w)) / 2;
    let modal_y = full_area.y + (full_area.h.saturating_sub(modal_h)) / 2;

    let area = Rect { x: modal_x, y: modal_y, w: modal_w, h: modal_h };

    // Fondo + borde
    canvas.fill_rect(area, ' ', Style::new().fg(SECONDARY));
    canvas.draw_border(area, Style::new().fg(CYAN));
    canvas.print_centered(area.x, area.y, area.w, &format!(" {} ", modal.title), Style::new().fg(CYAN).bold());

    // Campos
    for (i, field) in modal.fields.iter().enumerate() {
        let row_y = area.y + 1 + i as u16 * 3;
        if row_y + 2 >= area.bottom() {
            break;
        }

        let focused = state.modal_focused == i;
        let label_style = if focused { Style::new().fg(AMBER).bold() } else { Style::new().fg(SECONDARY) };
        let border_style = if focused { Style::new().fg(AMBER) } else { Style::new().fg(DIM) };

        canvas.print(area.x + 2, row_y, &field.label, label_style);

        // Caja del campo
        let field_w = modal_w.saturating_sub(4);
        let field_x = area.x + 2;
        canvas.hline(field_x, row_y + 1, field_w, '─', border_style);

        let value = modal.values.get(i).map(String::as_str).unwrap_or("");
        let display = match field.kind {
            ModalFieldKind::Secret => "•".repeat(value.len()),
            _ => value.to_string(),
        };

        let visible_w = field_w.saturating_sub(2) as usize;
        let start = display.len().saturating_sub(visible_w);
        let shown = &display[start..];
        canvas.print(field_x, row_y + 1, shown, Style::new().fg(GREEN));

        // Cursor en campo enfocado
        if focused {
            let cursor_x = (field_x + shown.chars().count() as u16).min(field_x + field_w - 1);
            canvas.print(cursor_x, row_y + 1, "▌", Style::new().fg(AMBER));
        }
    }

    // Ayuda inferior
    let hint_y = area.bottom().saturating_sub(1);
    canvas.print(area.x + 2, hint_y, "Tab siguiente  Enter guardar  Esc cancelar", Style::new().fg(DIM));
}
