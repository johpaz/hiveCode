use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER, CYAN, DIM, GREEN},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }

    let mode = if state.history_nav_mode { "NAV" } else { "INPUT" };
    let mode_style = if state.history_nav_mode {
        Style::new().fg(GREEN).bold()
    } else {
        Style::new().fg(AMBER).bold()
    };

    canvas.hline(area.x, area.y, area.w, '─', Style::new().fg(DIM));
    canvas.print(area.x + 1, area.y, "modo:", Style::new().fg(DIM));
    canvas.print(area.x + 7, area.y, mode, mode_style);

    // status_msg de Bun tiene prioridad; si está vacío mostrar atajos de teclado
    let right_content = if !state.status_msg.is_empty() {
        let prefix = if state.running { "⟳ " } else { "" };
        format!("{prefix}{}", state.status_msg)
    } else {
        format!(
            "Tab nav  Shift+Tab modo  Esc input  Ctrl+L cargar  Ctrl+Y copiar  Ctrl+C salir"
        )
    };

    let style = if state.running {
        Style::new().fg(CYAN)
    } else {
        Style::new().fg(DIM)
    };
    canvas.print(area.x + 13, area.y, &right_content, style);
}
