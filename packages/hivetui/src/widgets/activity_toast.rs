use crate::{
    state::AppState,
    term::{Canvas, Rect, Style, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, DIM},
    ui::text::truncate_cells,
};

/// Elimina secuencias ANSI (ESC [ ... m) y caracteres de control del texto.
fn sanitize_for_display(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            // Consumir secuencia ANSI: ESC [ params letra
            if chars.peek() == Some(&'[') {
                chars.next(); // consumir '['
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if ch.is_control() && ch != '\t' {
            continue;
        }
        out.push(ch);
    }
    out
}

/// Toast flotante de actividad que aparece justo encima del input
/// cuando `state.running` es true.
pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.w < 10 || area.h == 0 {
        return;
    }

    // Separador superior sutil
    if area.h >= 2 {
        let line: String = std::iter::repeat('─').take(area.w as usize).collect();
        canvas.print(area.x, area.y, &line, Style::new().fg(AMBER_DIM));
    }

    let content_y = if area.h >= 2 { area.y + 1 } else { area.y };

    // Fondo elevado para la línea de actividad
    canvas.fill_rect(
        Rect::new(area.x, content_y, area.w, 1),
        ' ',
        Style::new().bg(BG_ELEVATED),
    );

    // Spinner animado (4 frames, ~1s ciclo con anim_tick cada 120ms)
    let spinner_frames = &["◐", "◓", "◑", "◒"];
    let spin = spinner_frames[(state.anim_tick as usize) % spinner_frames.len()];

    // Preferir status_msg si existe; si no, usar activity_label del harness
    let raw_label = if !state.status_msg.is_empty() {
        format!("{spin} {}", state.status_msg)
    } else {
        format!("{spin} {}", state.harness.activity_label())
    };
    let label = sanitize_for_display(&raw_label);

    let avail = area.w.saturating_sub(4) as usize;
    let shown = truncate_cells(&label, avail);
    canvas.print(area.x + 2, content_y, &shown, Style::new().fg(AMBER_BRIGHT).bg(BG_ELEVATED));

    // Indicador de plan si hay uno activo
    if let Some(plan) = state.plan.current.as_ref() {
        let total = plan.phases.len();
        let done = plan.phases.iter().filter(|p| {
            matches!(p.status.as_str(), "done" | "completed" | "approved")
        }).count();
        if total > 0 && area.w > 50 {
            let progress = format!("[{}/{}]", done, total);
            let px = area.right().saturating_sub(progress.len() as u16 + 2);
            if px > area.x + 4 + shown.len() as u16 {
                canvas.print(px, content_y, &progress, Style::new().fg(DIM).bg(BG_ELEVATED));
            }
        }
    }
}
