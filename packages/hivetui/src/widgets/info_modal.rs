use crate::{
    state::{AppState, ModalState},
    term::{Canvas, Rect, Style, AMBER, DIM, GREEN, SECONDARY},
};

pub fn render(canvas: &mut Canvas, full_area: Rect, state: &AppState) {
    let ModalState::Info(modal) = &state.modal else {
        return;
    };

    let modal_w = (full_area.w.saturating_sub(8)).min(80).max(40);
    let modal_h = (full_area.h * 2 / 3).max(10).min(full_area.h.saturating_sub(4));
    let modal_x = full_area.x + (full_area.w.saturating_sub(modal_w)) / 2;
    let modal_y = full_area.y + (full_area.h.saturating_sub(modal_h)) / 2;

    let area = Rect { x: modal_x, y: modal_y, w: modal_w, h: modal_h };

    canvas.fill_rect(area, ' ', Style::new().fg(SECONDARY));
    canvas.draw_border(area, Style::new().fg(AMBER));
    canvas.print_centered(area.x, area.y, area.w, &format!(" {} ", modal.title), Style::new().fg(AMBER).bold());

    // Contenido con scroll
    let content_h = area.h.saturating_sub(3) as usize;
    let lines: Vec<&str> = modal.content.lines().collect();
    let start = modal.scroll.min(lines.len().saturating_sub(1));
    let visible = &lines[start..];

    for (i, line) in visible.iter().take(content_h).enumerate() {
        let y = area.y + 1 + i as u16;
        // Colorear líneas que empiezan con `/` como comandos
        let (text, style) = if line.starts_with('/') {
            let parts: Vec<&str> = line.splitn(2, ' ').collect();
            canvas.print(area.x + 2, y, parts[0], Style::new().fg(GREEN).bold());
            if let Some(desc) = parts.get(1) {
                canvas.print(area.x + 2 + parts[0].len() as u16 + 2, y, desc, Style::new().fg(DIM));
            }
            continue;
        } else {
            (line, Style::new().fg(SECONDARY))
        };
        canvas.print(area.x + 2, y, text, style);
    }

    // Scrollbar indicator + hint
    let hint_y = area.bottom().saturating_sub(1);
    canvas.print(area.x + 2, hint_y, "↑↓ scroll  Esc cerrar", Style::new().fg(DIM));

    // Indicador de scroll si hay más contenido
    if lines.len() > content_h {
        let pct = start * 100 / lines.len().saturating_sub(1);
        let pct_str = format!("{}%", pct);
        let pct_x = area.right().saturating_sub(pct_str.len() as u16 + 2);
        canvas.print(pct_x, hint_y, &pct_str, Style::new().fg(DIM));
    }
}
