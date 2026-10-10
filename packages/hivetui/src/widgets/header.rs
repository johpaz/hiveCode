use crate::{
    state::{AppState, ReplMode, WorkerStatus},
    term::{Canvas, Color, Rect, Style, AMBER_BRIGHT, AMBER_DIM, BG_PANEL, DIM, GREEN, SECONDARY, WHITE},
    ui::{cell_width, fmt_tokens, truncate_cells},
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
        let badge = if state.tab_locked {
            format!("{}✎ ", badge.trim_end())
        } else {
            badge.to_string()
        };
        canvas.print(x, y, &badge, Style::new().fg(fg_color).bg(bg_color).bold());
        x += cell_width(&badge) as u16;

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
        let context = state.session.coordinator_context.as_ref();
        let tok = token_meter(context.and_then(|ctx| ctx.input_tokens), context.and_then(|ctx| ctx.window), context.is_some_and(|ctx| ctx.estimated));
        canvas.print(x, y, &tok, Style::new().fg(SECONDARY));
        x += cell_width(&tok) as u16;

        // provider  ·  model
        let provider = context.map(|ctx| ctx.provider.as_str()).unwrap_or(&state.session.provider);
        let model = context.map(|ctx| ctx.model.as_str()).unwrap_or(&state.session.model);
        if !provider.is_empty() {
            sep!();
            let provider = truncate_cells(&format!("BEE {provider}"), 18);
            canvas.print(x, y, &provider, Style::new().fg(SECONDARY));
            x += cell_width(&provider) as u16;

            if !model.is_empty() {
                canvas.print(x, y, " · ", Style::new().fg(DIM));
                x += 3;
                let model = truncate_cells(model, 28);
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

fn token_meter(tokens: Option<u64>, window: Option<u64>, estimated: bool) -> String {
    let used = tokens.map(|n| format!("{}{}", if estimated { "~" } else { "" }, fmt_tokens(n))).unwrap_or_else(|| "—".into());
    match window.filter(|limit| *limit > 0) {
        Some(limit) => match tokens {
            Some(n) => format!("ctx:{used} / {} ({}%)", fmt_tokens(limit), ((n as u128 * 100) / limit as u128)),
            None => format!("ctx:{used} / {}", fmt_tokens(limit)),
        },
        None => format!("ctx:{used} tok"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_draws_token_meter_without_overlapping_clock() {
        let mut state = AppState::default();
        state.session.provider = "provider-with-a-very-long-name".to_string();
        state.session.model = "model-with-a-very-long-name-and-context".to_string();
        state.apply_message(crate::ipc::BunMessage::CoordinatorContext {agent:"bee".into(), session_id:None,
            provider:"custom-provider".into(), model:"custom-bee-model".into(), context_window:Some(128_000), input_tokens:Some(42_000), estimated:true});
        state.session.token_count = 900_000;
        state.clock = "12:34:56".to_string();

        let mut canvas = Canvas::new(80, 2);
        render(&mut canvas, Rect::new(0, 0, 80, 2), &state);
        let rows = canvas.to_text_rows();

        assert!(rows[0].contains("ctx:~42.0k"));
        assert!(rows[0].contains("12:34:56"));
    }

    #[test]
    fn header_keeps_bees_model_and_context_when_specialist_metrics_arrive() {
        let mut state = AppState::default();
        state.session.session_id = "s".into();
        state.session.provider = "session-provider".into();
        state.session.model = "session-model".into();
        state.apply_message(crate::ipc::BunMessage::CoordinatorContext {agent:"bee".into(), session_id:Some("s".into()),
            provider:"bee-provider".into(), model:"bee-model".into(), context_window:Some(128_000), input_tokens:Some(32_000), estimated:false});
        state.apply_message(crate::ipc::BunMessage::MetricsUpdate {token_count:Some(900_000), cost:None, elapsed_secs:None});
        state.apply_message(crate::ipc::BunMessage::CoordinatorContext {agent:"scout".into(), session_id:Some("s".into()),
            provider:"scout-provider".into(), model:"scout-model".into(), context_window:Some(200_000), input_tokens:Some(999), estimated:false});
        let mut canvas = Canvas::new(160, 2);
        render(&mut canvas, Rect::new(0,0,160,2), &state);
        let row = &canvas.to_text_rows()[0];
        assert!(row.contains("BEE bee-provider"), "{row}");
        assert!(row.contains("bee-model"), "{row}");
        assert!(row.contains("ctx:32.0k / 128.0k (25%)"), "{row}");
        assert!(!row.contains("900.0k"));
    }

    #[test]
    fn meter_uses_the_actual_window_and_has_no_invented_limit() {
        assert_eq!(token_meter(Some(32_000), Some(128_000), false), "ctx:32.0k / 128.0k (25%)");
        assert_eq!(token_meter(Some(32_000), None, true), "ctx:~32.0k tok");
        assert_eq!(token_meter(None, Some(128_000), false), "ctx:— / 128.0k");
    }

    #[test]
    fn header_zero_tokens_does_not_draw_empty_meter() {
        let mut state = AppState::default();
        state.session.token_count = 0;

        let mut canvas = Canvas::new(80, 2);
        render(&mut canvas, Rect::new(0, 0, 80, 2), &state);
        let row = &canvas.to_text_rows()[0];

        assert!(row.contains("ctx:— tok"));
        assert!(!row.contains("tokens:["));
    }
}
