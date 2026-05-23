use crate::{
    state::{AppState, ReplMode, WorkerStatus},
    term::{Canvas, Color, Rect, Style, AMBER_BRIGHT, AMBER_DIM, BG_PANEL, DIM, GREEN, SECONDARY, WHITE},
};

const BORDER_SUBTLE: Color = Color::Rgb { r: 35, g: 30, b: 20 };

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    // fondo de la línea de header
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let y = area.y;
    let mut x = area.x + 1;

    // ⬡ hiveCode
    canvas.print(x, y, "⬡ hiveCode", Style::new().fg(AMBER_BRIGHT).bold());
    x += 10;

    let sep = "  ·  ";
    macro_rules! sep {
        () => {
            canvas.print(x, y, sep, Style::new().fg(DIM));
            x += sep.chars().count() as u16;
        };
    }

    // provider  ·  model
    if !state.session.provider.is_empty() {
        sep!();
        canvas.print(x, y, &state.session.provider, Style::new().fg(SECONDARY));
        x += state.session.provider.chars().count() as u16;

        if !state.session.model.is_empty() {
            canvas.print(x, y, " · ", Style::new().fg(DIM));
            x += 3;
            canvas.print(x, y, &state.session.model, Style::new().fg(SECONDARY));
            x += state.session.model.chars().count() as u16;
        }

        // bun runtime badge
        sep!();
        canvas.print(x, y, "bun", Style::new().fg(WHITE));
        x += 3;
    }

    // [MODE] badge
    sep!();
    let (badge, bg_color, fg_color) = mode_badge(&state.session.mode);
    canvas.print(x, y, badge, Style::new().fg(fg_color).bg(bg_color).bold());
    x += badge.chars().count() as u16;

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
    x += wcount.chars().count() as u16;

    // tokens
    sep!();
    let tok = format!("tokens:{}", fmt_tokens(state.session.token_count));
    canvas.print(x, y, &tok, Style::new().fg(SECONDARY));
    x += tok.chars().count() as u16;

    // cost
    if !state.cost.is_empty() {
        sep!();
        canvas.print(x, y, &state.cost, Style::new().fg(SECONDARY));
    }

    // clock + ● live (derecha)
    let live_label = if state.clock.is_empty() {
        "● live".to_string()
    } else {
        format!("{} ●", state.clock)
    };
    let live_x = area.right().saturating_sub(live_label.chars().count() as u16 + 1);
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
