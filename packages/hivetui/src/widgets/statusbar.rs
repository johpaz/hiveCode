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
    let shown = truncate_cells(&right_content, area.w.saturating_sub(14) as usize);
    canvas.print(area.x + 13, area.y, &shown, style);
}
