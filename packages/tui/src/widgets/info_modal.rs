use crate::app::AppState;
use crate::term::{Canvas, Color, Rect, Style, AMBER, DIM, SECONDARY};

pub fn draw(canvas: &mut Canvas, state: &AppState) {
    if !state.show_info_modal { return; }
    let area = canvas.area();
    let modal_w = 70u16.min(area.w.saturating_sub(4));
    let modal_h = 20u16.min(area.h.saturating_sub(4));
    let mx = area.x + (area.w.saturating_sub(modal_w)) / 2;
    let my = area.y + (area.h.saturating_sub(modal_h)) / 2;
    let modal = Rect::new(mx, my, modal_w, modal_h);

    canvas.fill_rect(modal, ' ', Style::new().bg(Color::Indexed(235)));
    canvas.draw_border(modal, Style::new().fg(AMBER));

    let title = format!(" {} ", state.info_modal_title);
    canvas.print(mx + 1, my, &title, Style::new().fg(AMBER).bold().bg(Color::Indexed(235)));

    let inner = Rect::new(mx + 1, my + 1, modal_w - 2, modal_h - 2);
    let lines: Vec<&str> = state.info_modal_content.lines().collect();
    let start = state.info_scroll_offset.min(lines.len().saturating_sub(1));

    for (i, line) in lines[start..].iter().enumerate() {
        let y = inner.y + i as u16;
        if y >= inner.bottom() { break; }
        let max_w = inner.w as usize;
        let truncated = if line.len() > max_w { &line[..max_w] } else { line };
        canvas.print(inner.x, y, truncated, Style::new().fg(SECONDARY));
    }

    let hint_y = modal.bottom() - 1;
    canvas.print(mx + 1, hint_y, " Esc cerrar · ↑↓ scroll ",
        Style::new().fg(DIM).bg(Color::Indexed(235)));
}
