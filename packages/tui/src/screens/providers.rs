use crate::app::AppState;
use crate::term::{Canvas, Rect, Style, AMBER, DIM, GREEN};

pub fn draw(canvas: &mut Canvas, state: &AppState) {
    let area = canvas.area();
    let parts = area.vsplit(&[2, 0, 1]);

    // Header
    canvas.print(parts[0].x, parts[0].y,
        " Providers LLM ", Style::new().fg(AMBER).bold());
    canvas.print(parts[0].x + 16, parts[0].y, "  │  ", Style::new().fg(DIM));
    let default = if state.provider.is_empty() { "—" } else { &state.provider };
    canvas.print(parts[0].x + 21, parts[0].y,
        &format!("Default: {}", default), Style::new().fg(GREEN));

    // Table (placeholder)
    let table = parts[1];
    canvas.draw_border(table, Style::new().fg(DIM));
    canvas.print(table.x + 1, table.y + 1, "(vacío)", Style::new().fg(DIM));

    // Hints
    let hints_row = parts[2].y;
    canvas.print(parts[2].x,     hints_row, " s ", Style::new().fg(AMBER));
    canvas.print(parts[2].x + 3, hints_row, "set-default", Style::new().fg(DIM));
    canvas.print(parts[2].x + 14, hints_row, "  d ", Style::new().fg(AMBER));
    canvas.print(parts[2].x + 18, hints_row, "eliminar", Style::new().fg(DIM));
    canvas.print(parts[2].x + 26, hints_row, "  q ", Style::new().fg(AMBER));
    canvas.print(parts[2].x + 30, hints_row, "salir", Style::new().fg(DIM));
}
