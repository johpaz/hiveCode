use crate::app::AppState;
use crate::term::{Canvas, Color, Rect, Style, AMBER, DIM};

pub fn draw(canvas: &mut Canvas, state: &AppState, rect: Rect) {
    if rect.h == 0 { return; }
    let bg = Color::Indexed(234);

    // Borde superior
    canvas.print(rect.x, rect.y, "┌", Style::new().fg(AMBER).bg(bg));
    canvas.hline(rect.x + 1, rect.y, rect.w - 2, '─', Style::new().fg(AMBER).bg(bg));
    canvas.print(rect.right() - 1, rect.y, "┐", Style::new().fg(AMBER).bg(bg));

    // Área de texto
    if rect.h >= 2 {
        canvas.print(rect.x, rect.y + 1, "│", Style::new().fg(AMBER).bg(bg));
        canvas.print(rect.right() - 1, rect.y + 1, "│", Style::new().fg(AMBER).bg(bg));

        // Prompt
        let prompt = if state.shell_mode { "$ " } else { "▸ " };
        let prompt_x = rect.x + 1;
        canvas.print(prompt_x, rect.y + 1, prompt,
            Style::new().fg(if state.shell_mode { Color::Indexed(114) } else { AMBER }));

        // Texto del input (con scroll si es necesario)
        let text_x    = prompt_x + prompt.chars().count() as u16;
        let max_chars = (rect.w.saturating_sub(3)) as usize;
        let value     = state.input.value();
        let cursor    = state.input.cursor;

        // Calcular ventana visible (scroll horizontal)
        let visible_start = if cursor >= max_chars { cursor - max_chars + 1 } else { 0 };
        let visible: String = value.chars().skip(visible_start).take(max_chars).collect();

        canvas.print(text_x, rect.y + 1, &visible, Style::new().fg(Color::White));

        // Cursor
        if state.cursor_visible && !state.running {
            let cursor_col = cursor.saturating_sub(visible_start) as u16;
            let cx = text_x + cursor_col;
            if cx < rect.right() - 1 {
                let ch = visible.chars().nth(cursor.saturating_sub(visible_start)).unwrap_or(' ');
                canvas.put(cx, rect.y + 1,
                    crate::term::Cell::new(ch, Style::new().fg(Color::Black).bg(AMBER)));
            }
        }
    }

    // Borde inferior
    if rect.h >= 3 {
        let last_y = rect.y + rect.h - 1;
        canvas.print(rect.x, last_y, "└", Style::new().fg(AMBER).bg(bg));
        canvas.hline(rect.x + 1, last_y, rect.w - 2, '─', Style::new().fg(AMBER).bg(bg));
        canvas.print(rect.right() - 1, last_y, "┘", Style::new().fg(AMBER).bg(bg));

        // Hint contextual
        let hint = if state.running { "procesando..." } else { "Enter enviar  Shift+Tab modo  Ctrl+C salir" };
        let hint_x = rect.x + 2;
        canvas.print(hint_x, last_y, hint, Style::new().fg(DIM));
    }
}
