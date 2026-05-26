use crate::{
    state::{AppState, WorkerStatus},
    term::{
        Canvas, Color, Rect, Style,
        AMBER_BRIGHT, BG_ELEVATED, BG_PANEL, BLUE, CYAN,
        DIM, GREEN, LAVENDER, PINK, PURPLE, RED, SECONDARY, YELLOW,
    },
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if state.workers.workers.is_empty() {
        render_empty(canvas, area);
        return;
    }

    // Grid of worker cards
    // Each card: min 18 wide × 6 tall
    let card_w: u16 = 22;
    let card_h: u16 = 6;
    let cols_per_row = (area.w / card_w).max(1);

    let mut idx = 0usize;
    for w in state.workers.workers.iter() {
        let col = (idx as u16) % cols_per_row;
        let row = (idx as u16) / cols_per_row;

        let cx = area.x + col * card_w;
        let cy = area.y + row * card_h;

        if cy + card_h > area.bottom() {
            break;
        }

        let card = Rect::new(cx, cy, card_w.min(area.right().saturating_sub(cx)), card_h);
        canvas.with_clip(card, |canvas| render_worker_card(canvas, card, w));
        idx += 1;
    }

    // Summary line at bottom
    let total = state.workers.workers.len();
    let running = state.workers.workers.iter().filter(|w| matches!(w.status, WorkerStatus::Running)).count();
    let summary = format!("⬡ {running}/{total} workers activos  ·  tokens:{}", fmt_tokens(state.session.token_count));
    let sy = area.bottom().saturating_sub(1);
    canvas.print(area.x + 1, sy, &summary, Style::new().fg(DIM));
}

fn render_worker_card(canvas: &mut Canvas, area: Rect, w: &crate::state::Worker) {
    // Card background
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    // Hex corners
    let tl = area;
    canvas.print(tl.x, tl.y, "⬡", Style::new().fg(worker_color(&w.name)));
    canvas.print(tl.right().saturating_sub(1), tl.y, "⬡", Style::new().fg(worker_color(&w.name)));
    canvas.print(tl.x, tl.bottom().saturating_sub(1), "⬡", Style::new().fg(worker_color(&w.name)));
    canvas.print(tl.right().saturating_sub(1), tl.bottom().saturating_sub(1), "⬡", Style::new().fg(worker_color(&w.name)));

    let wcolor = worker_color(&w.name);

    // Name row
    canvas.print(area.x + 2, area.y, "⬡ ", Style::new().fg(wcolor).bold());
    let max_name = (area.w.saturating_sub(5)) as usize;
    let name: String = w.name.chars().take(max_name).collect();
    canvas.print(area.x + 4, area.y, &name, Style::new().fg(wcolor).bold());

    // Status
    let (status_str, status_color) = match w.status {
        WorkerStatus::Running => ("● running", GREEN),
        WorkerStatus::Done    => ("✓ done",    GREEN),
        WorkerStatus::Failed  => ("✗ failed",  RED),
        WorkerStatus::Waiting => ("○ waiting", DIM),
        WorkerStatus::Warn => ("⚠ warn", YELLOW),
    };
    canvas.print(area.x + 2, area.y + 1, status_str, Style::new().fg(status_color).bold());

    // Detail / action
    if let Some(ref detail) = w.detail {
        let avail = area.w.saturating_sub(3) as usize;
        let shown: String = detail.chars().take(avail).collect();
        canvas.print(area.x + 2, area.y + 2, &shown, Style::new().fg(SECONDARY));
    }

    // Conflict indicator
    // (placeholder — would need conflict data per worker in a future iteration)
}

fn render_empty(canvas: &mut Canvas, area: Rect) {
    let msg = "⬡ sin workers registrados";
    let x = area.x + area.w.saturating_sub(msg.chars().count() as u16) / 2;
    let y = area.y + area.h / 2;
    canvas.print(x, y, msg, Style::new().fg(DIM));
    canvas.print(x, y + 1, "inicia una tarea para ver el dashboard", Style::new().fg(DIM));
}

fn worker_color(name: &str) -> Color {
    const ROLES: &[(&str, Color)] = &[
        ("bee",    AMBER_BRIGHT),
        ("arch",   PURPLE),
        ("back",   BLUE),
        ("front",  CYAN),
        ("sec",    PINK),
        ("test",   YELLOW),
        ("devops", LAVENDER),
    ];
    ROLES.iter().find(|(k, _)| name.contains(k)).map(|(_, c)| *c).unwrap_or(SECONDARY)
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
