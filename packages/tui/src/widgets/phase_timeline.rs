use crate::app::AppState;
use crate::term::{Canvas, Color, Rect, Style, AMBER, DIM, GREEN, RED, SECONDARY};

pub fn draw(canvas: &mut Canvas, state: &AppState, rect: Rect) {
    if rect.h == 0 { return; }
    canvas.draw_border(rect, Style::new().fg(DIM));
    canvas.print(rect.x + 1, rect.y, " Timeline ", Style::new().fg(AMBER));

    let inner = Rect::new(rect.x + 1, rect.y + 1, rect.w.saturating_sub(2), rect.h.saturating_sub(2));

    for (i, phase) in state.phases.iter().enumerate() {
        let y = inner.y + i as u16;
        if y >= inner.bottom() { break; }

        let (icon, color) = match phase.status.as_str() {
            "running" => ("►", AMBER),
            "done"    => ("✓", GREEN),
            "error"   => ("✗", RED),
            _         => ("○", DIM),
        };

        let label = format!(" {} {:20} {}", icon, phase.coordinator, phase.status);
        canvas.print(inner.x, y, &label, Style::new().fg(color));
    }
}
