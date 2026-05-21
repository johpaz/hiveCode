use crate::app::AppState;
use crate::term::{Canvas, Color, Rect, Style, AMBER, DIM, SECONDARY};

pub fn draw(canvas: &mut Canvas, state: &AppState, rect: Rect) {
    if !state.show_popup || state.suggestions.is_empty() { return; }

    let max_items = 8.min(state.suggestions.len());
    let popup_w   = 40u16.min(rect.w.saturating_sub(4));
    let popup_h   = (max_items as u16) + 2;

    // Popup sobre el campo de input (parte inferior del rect)
    let popup_y = rect.bottom().saturating_sub(popup_h + 6);
    let popup_x = rect.x + 2;

    let popup_rect = Rect::new(popup_x, popup_y, popup_w, popup_h);
    canvas.fill_rect(popup_rect, ' ', Style::new().bg(Color::Indexed(236)));
    canvas.draw_border(popup_rect, Style::new().fg(AMBER));

    for (i, suggestion) in state.suggestions.iter().take(max_items).enumerate() {
        let y      = popup_y + 1 + i as u16;
        let is_sel = i == state.popup_sel;
        let (fg, bg) = if is_sel {
            (Color::Black, AMBER)
        } else {
            (SECONDARY, Color::Indexed(236))
        };
        let item = format!(" {:width$}", suggestion, width = (popup_w - 2) as usize);
        canvas.print(popup_x + 1, y, &item, Style::new().fg(fg).bg(bg));
    }
}
