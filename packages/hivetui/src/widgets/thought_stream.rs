use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER, DIM, SECONDARY},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.draw_border(area, Style::new().fg(DIM));
    canvas.print(area.x + 2, area.y, " pensamiento ", Style::new().fg(DIM).bold());

    let content_h = area.h.saturating_sub(2) as usize;
    let chunks = &state.thought.chunks;

    if chunks.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "esperando…", Style::new().fg(DIM).dim());
        return;
    }

    let start = chunks.len().saturating_sub(content_h);
    for (i, chunk) in chunks[start..].iter().enumerate() {
        let y = area.y + 1 + i as u16;
        if y >= area.bottom().saturating_sub(1) {
            break;
        }

        let label = format!("{}: ", chunk.coordinator);
        let label_w = label.len() as u16;
        canvas.print(area.x + 1, y, &label, Style::new().fg(AMBER));

        let content_x = area.x + 1 + label_w;
        if content_x < area.right().saturating_sub(1) {
            let avail = area.right().saturating_sub(content_x + 1) as usize;
            let shown: String = chunk.content.chars().take(avail).collect();
            canvas.print(content_x, y, &shown, Style::new().fg(SECONDARY));
        }
    }
}
