use crate::{
    state::AppState,
    term::{Canvas, Cell, Color, Rect, Style, AMBER},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.draw_border(area, Style::new().fg(AMBER));
    canvas.print(area.x + 2, area.y, "input", Style::new().fg(AMBER).bold());

    let visible = state.input.visible_segment(area.w.saturating_sub(6) as usize);
    canvas.print(area.x + 2, area.y + 1, "▸ ", Style::new().fg(AMBER).bold());
    canvas.print(area.x + 4, area.y + 1, &visible.text, Style::new());

    if state.cursor_visible && !state.history_nav_mode {
        let cursor_x = area
            .x
            .saturating_add(4)
            .saturating_add(visible.cursor_column as u16)
            .min(area.right().saturating_sub(2));
        let cursor_y = area.y + 1;

        canvas.put(
            cursor_x,
            cursor_y,
            Cell::new(
                ' ',
                Style::new()
                    .fg(Color::Black)
                    .bg(AMBER)
                    .bold(),
            ),
        );
    }
}
