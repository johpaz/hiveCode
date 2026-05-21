use crate::app::AppState;
use crate::term::{Canvas, Color, Rect, Style, AMBER, DIM, GREEN, SECONDARY};

pub fn draw(canvas: &mut Canvas, state: &AppState, rect: Rect) {
    if rect.h == 0 { return; }
    let bg = Color::Indexed(234);
    canvas.fill_rect(rect, ' ', Style::new().bg(bg));

    // Línea 0: proyecto + sesión
    let title = format!(" ◆ {} ", state.project_name);
    canvas.print(rect.x, rect.y, &title, Style::new().fg(AMBER).bold().bg(bg));

    let session = if state.session_id.is_empty() { "—".to_string() } else { state.session_id.clone() };
    let sess_str = format!("session: {}", session);
    let sess_x = rect.right().saturating_sub(sess_str.chars().count() as u16 + 1);
    canvas.print(sess_x, rect.y, &sess_str, Style::new().fg(DIM).bg(bg));

    // Línea 1: provider + model + workers
    if rect.h >= 2 {
        let prov = format!(" {} · {} ", state.provider, state.model);
        canvas.print(rect.x, rect.y + 1, &prov, Style::new().fg(GREEN).bg(bg));

        let wcount = format!("{} workers", state.workers.len());
        let w_x = rect.right().saturating_sub(wcount.chars().count() as u16 + 1);
        canvas.print(w_x, rect.y + 1, &wcount, Style::new().fg(SECONDARY).bg(bg));
    }

    // Línea 2: separador
    if rect.h >= 3 {
        canvas.hline(rect.x, rect.y + 2, rect.w, '─', Style::new().fg(DIM).bg(bg));
    }
}
