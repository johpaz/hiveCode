use crate::app::AppState;
use crate::term::{Canvas, Rect};
use crate::widgets::{command_popup, config_modal, header, history, info_modal, input,
                     log_panel, mascot, phase_timeline, statusbar, welcome};

pub fn draw(canvas: &mut Canvas, state: &mut AppState) {
    let area = canvas.area();

    if state.history.is_empty() {
        // ── Welcome: contenido + input + statusbar ────────────────────────────
        // vsplit con 0 = Fill (ocupa el espacio restante)
        let parts = area.vsplit(&[0, 5, 1]);

        welcome::draw(canvas, state, parts[0]);
        input::draw(canvas, state, parts[1]);
        statusbar::draw(canvas, state, parts[2]);

        // Mascota superpuesta (esquina inferior derecha de toda el área)
        mascot::draw(canvas, state, area);
        // Popup de sugerencias
        command_popup::draw(canvas, state, area);
    } else {
        // ── Sesión activa: header + body + input + statusbar ──────────────────
        let parts = area.vsplit(&[3, 0, 5, 1]);
        let (header_rect, body_rect, input_rect, status_rect) =
            (parts[0], parts[1], parts[2], parts[3]);

        header::draw(canvas, state, header_rect);

        // Body: opcionalmente split horizontal con log panel
        if state.show_logs {
            let body_parts = body_rect.hsplit(&[0, body_rect.w / 3]);
            history::draw(canvas, state, body_parts[0]);
            log_panel::draw(canvas, state, body_parts[1]);
        } else if state.show_timeline {
            let body_parts = body_rect.vsplit(&[16, 0]);
            phase_timeline::draw(canvas, state, body_parts[0]);
            history::draw(canvas, state, body_parts[1]);
        } else {
            history::draw(canvas, state, body_rect);
        }

        input::draw(canvas, state, input_rect);
        statusbar::draw(canvas, state, status_rect);

        mascot::draw(canvas, state, area);
        command_popup::draw(canvas, state, area);
    }

    // Modales (siempre encima de todo)
    config_modal::draw(canvas, state);
    info_modal::draw(canvas, state);
}
