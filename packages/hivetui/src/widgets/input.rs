use crate::{
    state::{AppState, ReplMode},
    term::{
        Canvas, Cell, Color, Rect, Style,
        AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM, RED, WHITE,
    },
};

// 8-frame color cycle for the 🐝 emoji (matching 200ms × 8 = 1.6s loop)
const BEE_COLORS: [Color; 8] = [
    DIM, DIM, AMBER_DIM, AMBER, AMBER_BRIGHT, AMBER, AMBER_DIM, DIM,
];

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    // Flat top border — single separator line
    let border_line: String = std::iter::repeat('─').take(area.w as usize).collect();
    canvas.print(area.x, area.y, &border_line, Style::new().fg(AMBER_DIM));

    let y = area.y + 1;

    // 🐝 mascot — 8-frame color animation
    let bee_color = BEE_COLORS[(state.anim_tick % 8) as usize];
    canvas.print(area.x + 1, y, "🐝", Style::new().fg(bee_color));

    // ⬡ prompt
    canvas.print(area.x + 3, y, "⬡", Style::new().fg(AMBER_BRIGHT).bold());

    // ⛔ stop — always visible; red when conflict active, dim otherwise
    let stop_color = if !state.conflicts.entries.is_empty() { RED } else { DIM };
    let stop_x = area.right().saturating_sub(3);
    canvas.print(stop_x, y, "⛔", Style::new().fg(stop_color));

    // MODE badge (right side, to the left of ⛔)
    let (badge, bg_col, fg_col) = mode_badge_style(&state.session.mode);
    let badge_w = badge.chars().count() as u16;
    let badge_x = stop_x.saturating_sub(badge_w + 2);
    canvas.print(badge_x, y, badge, Style::new().fg(fg_col).bg(bg_col).bold());

    // shift+tab hint (to the left of badge)
    let hint_x = badge_x.saturating_sub(12);
    if hint_x > area.x + 10 {
        canvas.print(hint_x, y, "shift+tab", Style::new().fg(DIM));
    }

    // Input area with BG_ELEVATED background — from x+5 to badge_x-2
    let input_x = area.x + 5;
    let input_end = hint_x.saturating_sub(1);
    if input_end > input_x {
        let iw = input_end - input_x;
        canvas.fill_rect(Rect::new(input_x, y, iw, 1), ' ', Style::new().bg(BG_ELEVATED));
    }

    // Input text
    let badge_reserve = badge_w + 4 + 3; // badge + gap + stop
    let available = area.w.saturating_sub(5 + badge_reserve) as usize;
    let visible = state.input.visible_segment(available);
    canvas.print(area.x + 5, y, &visible.text, Style::new().fg(WHITE).bg(BG_ELEVATED));

    // Cursor — always visible, shows the character underneath (inverted) so the
    // first typed character is never hidden.
    if !state.history_nav_mode {
        let cursor_x = area
            .x
            .saturating_add(5)
            .saturating_add(visible.cursor_column as u16)
            .min(badge_x.saturating_sub(2));
        let ch_under = visible.text
            .chars()
            .nth(visible.cursor_column)
            .unwrap_or(' ');
        canvas.put(cursor_x, y, Cell::new(ch_under, Style::new().fg(Color::Black).bg(AMBER).bold()));
    }

    // Hint line (row 2)
    if area.h > 2 {
        let y2 = area.y + 2;
        let hint = if state.history_nav_mode {
            "nav mode · ↑↓ mover · Esc volver · Ctrl+Y copiar"
        } else if state.input.value().starts_with('/') {
            "/ comandos · Tab autocompletar · ↑↓ navegar"
        } else {
            "/ comandos  ·  Tab navegar historial  ·  Ctrl+C salir"
        };
        let avail = area.w.saturating_sub(3) as usize;
        let shown: String = hint.chars().take(avail).collect();
        canvas.print(area.x + 2, y2, &shown, Style::new().fg(DIM));
    }
}

fn mode_badge_style(mode: &ReplMode) -> (&'static str, Color, Color) {
    match mode {
        ReplMode::Plan     => (" PLAN ",     Color::Rgb { r: 17, g: 24, b: 39  }, Color::Rgb { r: 74,  g: 158, b: 255 }),
        ReplMode::Approval => (" APPROVAL ", Color::Rgb { r: 28, g: 20, b: 0   }, Color::Rgb { r: 252, g: 211, b: 77  }),
        ReplMode::Auto     => (" AUTO ",     Color::Rgb { r: 5,  g: 31, b: 18  }, Color::Rgb { r: 74,  g: 222, b: 128 }),
    }
}
