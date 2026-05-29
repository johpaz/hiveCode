use crate::{
    state::{AppState, ReplMode, WorkerStatus},
    term::{Canvas, Color, Rect, Style, AMBER_BRIGHT, AMBER_DIM, BG_PANEL, DIM, GREEN, SECONDARY, WHITE},
    ui::{cell_width, truncate_cells},
};

const BORDER_SUBTLE: Color = Color::Rgb { r: 35, g: 30, b: 20 };

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    // fondo de la línea de header
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let y = area.y;
    let live_label = if state.clock.is_empty() {
        "● live".to_string()
    } else {
        format!("{} ●", state.clock)
    };
    let live_x = area.right().saturating_sub(cell_width(&live_label) as u16 + 1);
    let left_area = Rect::new(
        area.x,
        y,
        live_x.saturating_sub(area.x).saturating_sub(1),
        1,
    );

    canvas.with_clip(left_area, |canvas| {
        let mut x = area.x + 1;

        // ⬡ hiveCode + mascot face (expression changes with mode)
        canvas.print(x, y, "⬡ hiveCode", Style::new().fg(AMBER_BRIGHT).bold());
        x += 10;
        let face = match state.session.mode {
            ReplMode::Plan     => "\\(^•^)/",
            ReplMode::Approval => "(?•?)",
            ReplMode::Auto     => "(•ᴗ•)",
        };
        canvas.print(x + 1, y, face, Style::new().fg(GREEN).bold());
        x += 1 + cell_width(face) as u16;

        let sep = "  ·  ";
        macro_rules! sep {
            () => {
                canvas.print(x, y, sep, Style::new().fg(DIM));
                x += cell_width(sep) as u16;
            };
        }

        // [MODE] badge
        sep!();
        let (badge, bg_color, fg_color) = mode_badge(&state.session.mode);
        canvas.print(x, y, badge, Style::new().fg(fg_color).bg(bg_color).bold());
        x += cell_width(badge) as u16;

        // ⬡N workers activos
        let active = state
            .workers
            .workers
            .iter()
            .filter(|w| matches!(w.status, WorkerStatus::Running))
            .count();
        sep!();
        let wcount = format!("⬡{active}");
        canvas.print(x, y, &wcount, Style::new().fg(AMBER_DIM));
        x += cell_width(&wcount) as u16;

        // tokens
        sep!();
        let tok = token_meter(state.session.token_count);
        canvas.print(x, y, &tok, Style::new().fg(SECONDARY));
        x += cell_width(&tok) as u16;

        // provider  ·  model
        if !state.session.provider.is_empty() {
            sep!();
            let provider = truncate_cells(&state.session.provider, 18);
            canvas.print(x, y, &provider, Style::new().fg(SECONDARY));
            x += cell_width(&provider) as u16;

            if !state.session.model.is_empty() {
                canvas.print(x, y, " · ", Style::new().fg(DIM));
                x += 3;
                let model = truncate_cells(&state.session.model, 28);
                canvas.print(x, y, &model, Style::new().fg(SECONDARY));
                x += cell_width(&model) as u16;
            }

            // bun runtime badge
            sep!();
            canvas.print(x, y, "bun", Style::new().fg(WHITE));
            x += 3;
        }

        // cost
        if !state.cost.is_empty() {
            sep!();
            canvas.print(x, y, &state.cost, Style::new().fg(SECONDARY));
        }
    });

    canvas.print(live_x, y, &live_label, Style::new().fg(GREEN).bold());

    // Separador sutil bajo el header (fila 2 del área de 2 filas)
    if area.h >= 2 {
        let sep: String = std::iter::repeat('─').take(area.w as usize).collect();
        canvas.print(area.x, area.y + 1, &sep, Style::new().fg(BORDER_SUBTLE).bg(BG_PANEL));
    }
}

fn mode_badge(mode: &ReplMode) -> (&'static str, Color, Color) {
    match mode {
        ReplMode::Plan     => (" PLAN ",       Color::Rgb { r: 17, g: 24, b: 39  }, Color::Rgb { r: 74, g: 158, b: 255 }),
        ReplMode::Approval => (" APPROVAL ",   Color::Rgb { r: 28, g: 20, b: 0   }, Color::Rgb { r: 252, g: 211, b: 77 }),
        ReplMode::Auto     => (" AUTO ",       Color::Rgb { r: 5, g: 31, b: 18   }, Color::Rgb { r: 74, g: 222, b: 128 }),
    }
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn token_meter(n: u64) -> String {
    if n == 0 {
        return "ctx:0 tok".to_string();
    }
    const SOFT_LIMIT: u64 = 200_000;
    let pct = ((n.min(SOFT_LIMIT) * 100) / SOFT_LIMIT).max(1);
    format!("ctx:{} / 200k ({}%)", fmt_tokens(n), pct)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_draws_token_meter_without_overlapping_clock() {
        let mut state = AppState::default();
        state.session.provider = "provider-with-a-very-long-name".to_string();
        state.session.model = "model-with-a-very-long-name-and-context".to_string();
        state.session.token_count = 42_000;
        state.clock = "12:34:56".to_string();

        let mut canvas = Canvas::new(80, 2);
        render(&mut canvas, Rect::new(0, 0, 80, 2), &state);
        let rows = canvas.to_text_rows();

        assert!(rows[0].contains("ctx:42.0k"));
        assert!(rows[0].contains("12:34:56"));
    }

    #[test]
    fn header_zero_tokens_does_not_draw_empty_meter() {
        let mut state = AppState::default();
        state.session.token_count = 0;

        let mut canvas = Canvas::new(80, 2);
        render(&mut canvas, Rect::new(0, 0, 80, 2), &state);
        let row = &canvas.to_text_rows()[0];

        assert!(row.contains("ctx:0 tok"));
        assert!(!row.contains("tokens:["));
    }
}
