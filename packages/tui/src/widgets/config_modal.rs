use crate::app::AppState;
use crate::term::{Canvas, Color, Rect, Style, AMBER, DIM, RED, SECONDARY};

pub fn draw(canvas: &mut Canvas, state: &AppState) {
    if !state.show_modal { return; }
    let area = canvas.area();
    // Centro de pantalla
    let modal_w = 60u16.min(area.w.saturating_sub(4));
    let modal_h = (state.modal_fields.len() as u16 * 3 + 4).min(area.h.saturating_sub(2));
    let mx = area.x + (area.w.saturating_sub(modal_w)) / 2;
    let my = area.y + (area.h.saturating_sub(modal_h)) / 2;
    let modal = Rect::new(mx, my, modal_w, modal_h);

    canvas.fill_rect(modal, ' ', Style::new().bg(Color::Indexed(235)));
    canvas.draw_border(modal, Style::new().fg(AMBER));

    let title = format!(" {} ", state.modal_title);
    canvas.print(mx + 1, my, &title, Style::new().fg(AMBER).bold().bg(Color::Indexed(235)));

    for (i, field) in state.modal_fields.iter().enumerate() {
        let fy = my + 1 + i as u16 * 3;
        if fy + 2 >= modal.bottom() { break; }

        let label = format!(" {}:", field.label);
        canvas.print(mx + 1, fy, &label, Style::new().fg(SECONDARY));

        let value_y = fy + 1;
        let value   = state.modal_values.get(i).map(|s| s.as_str()).unwrap_or("");
        let is_focused = i == state.modal_focused;
        let has_error  = state.modal_errors.get(i).copied().unwrap_or(false);

        let (fg, bg) = if has_error {
            (RED, Color::Indexed(52))
        } else if is_focused {
            (Color::White, Color::Indexed(238))
        } else {
            (SECONDARY, Color::Indexed(236))
        };

        let val_w = modal_w.saturating_sub(4) as usize;
        let padded = format!(" {:width$}", value, width = val_w);
        canvas.print(mx + 2, value_y, &padded, Style::new().fg(fg).bg(bg));
    }

    // Hint
    let hint_y = modal.bottom().saturating_sub(1);
    canvas.print(mx + 1, hint_y, " Tab nav · Ctrl+S guardar · Esc cancelar ",
        Style::new().fg(DIM).bg(Color::Indexed(235)));
}
