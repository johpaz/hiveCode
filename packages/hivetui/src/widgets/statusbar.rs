use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER, CYAN, DIM, GREEN, RED},
    ui::truncate_cells,
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new());

    let mode = if state.history_nav_mode { "NAV" } else { "INPUT" };
    let mode_style = if state.history_nav_mode {
        Style::new().fg(GREEN).bold()
    } else {
        Style::new().fg(AMBER).bold()
    };

    canvas.hline(area.x, area.y, area.w, '─', Style::new().fg(DIM));
    canvas.print(area.x + 1, area.y, "modo:", Style::new().fg(DIM));
    canvas.print(area.x + 7, area.y, mode, mode_style);

    let left_w = 13;

    // Prioridad: confirmación destructiva > sugerencia de layout > razón de
    // transición > mensaje de Bun > atajos según el contexto de teclado real.
    let suggestion = state.pending_layout_suggestion();
    let typing = !state.input.value().is_empty();

    let (right_content, style) = if state.dashboard.halt_confirm {
        (
            "⚠ detener el enjambre · Enter confirma · Esc cancela".to_string(),
            Style::new().fg(RED).bold(),
        )
    } else if state.dashboard.rollback_confirm_checkpoint.is_some() {
        (
            "⚠ rollback · Enter confirma · Esc cancela".to_string(),
            Style::new().fg(RED).bold(),
        )
    } else if let Some(tab) = suggestion {
        let why = state
            .routing
            .transition_reason
            .as_deref()
            .unwrap_or("hay actividad nueva");
        (
            format!("→ {} [{}] · {}", tab.label(), tab.num(), why),
            Style::new().fg(AMBER).bold(),
        )
    } else if let Some(reason) = state.routing.transition_reason.as_deref() {
        (reason.to_string(), Style::new().fg(AMBER).bold())
    } else if !state.status_msg.is_empty() {
        let prefix = if state.running { "⟳ " } else { "" };
        (
            format!("{prefix}{}", state.status_msg),
            if state.running { Style::new().fg(CYAN) } else { Style::new().fg(DIM) },
        )
    } else if typing {
        // Con texto en el input las flechas y las letras son edición, no atajos.
        (
            "Enter enviar  ←/→ cursor  Ctrl+←/→ palabra  Esc limpiar  Ctrl+C salir".to_string(),
            Style::new().fg(DIM),
        )
    } else if state.history_nav_mode {
        (
            "↑/↓ entrada  Shift+←/→ scroll  Ctrl+L cargar  Ctrl+Y copiar  Tab salir".to_string(),
            Style::new().fg(DIM),
        )
    } else {
        (
            "1-5 vistas  Tab nav  Shift+Tab modo  ←/→ checkpoint  Ctrl+C salir".to_string(),
            Style::new().fg(DIM),
        )
    };
    let avail = area.w.saturating_sub(left_w + 1) as usize;
    let shown = truncate_cells(&right_content, avail);
    canvas.print(area.x + left_w, area.y, &shown, style);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::term::Canvas;

    fn bar(canvas: &mut Canvas, w: u16, state: &AppState) -> String {
        let area = Rect::new(0, 0, w, 1);
        render(canvas, area, state);
        canvas.to_text_rows().remove(0)
    }

    #[test]
    fn the_bar_shows_the_input_mode() {
        let mut canvas = Canvas::new(120, 1);
        let row = bar(&mut canvas, 120, &AppState::default());

        assert!(row.contains("modo:"), "{row}");
    }

    #[test]
    fn a_destructive_confirmation_keeps_its_room() {
        // La prioridad del statusbar no se negocia: si hay un halt pendiente,
        // su aviso tiene que verse.
        let mut state = AppState::default();
        state.dashboard.halt_confirm = true;
        let mut canvas = Canvas::new(120, 1);
        let row = bar(&mut canvas, 120, &state);

        assert!(row.contains("detener el enjambre"), "{row}");
    }

    #[test]
    fn a_narrow_terminal_does_not_overflow_the_row() {
        let mut canvas = Canvas::new(46, 1);
        let row = bar(&mut canvas, 46, &AppState::default());

        assert!(row.chars().count() <= 46, "{row}");
    }

    #[test]
    fn rendering_never_panics_on_a_tiny_area() {
        for w in 0..40u16 {
            let mut canvas = Canvas::new(w.max(1), 1);
            let _ = bar(&mut canvas, w, &AppState::default());
        }
    }
}
