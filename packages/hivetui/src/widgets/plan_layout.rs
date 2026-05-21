use crate::{
    state::{AppState, RiskLevel},
    term::{Canvas, Rect, Style, AMBER, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM, GREEN, RED, SECONDARY, WHITE, YELLOW},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if area.w < 40 {
        return;
    }

    // 60/40 split: left = thought stream, right = filemap
    let left_w = area.w * 60 / 100;
    let cols = area.hsplit(&[left_w, 0]);
    let left = cols[0];
    let right = cols[1];

    render_thought_pane(canvas, left, state);
    render_filemap_pane(canvas, right, state);
}

fn render_thought_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    // Panel title
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    let title = "⬡ RAZONAMIENTO · streaming";
    canvas.print(area.x + 1, area.y, title, Style::new().fg(AMBER).bold());

    let avail_h = area.h.saturating_sub(2) as usize;
    let chunks = &state.thought.chunks;

    // Show most-recent chunks (bottom-aligned)
    let start = chunks.len().saturating_sub(avail_h);
    let mut y = area.y + 1;

    for chunk in chunks.iter().skip(start) {
        if y >= area.bottom().saturating_sub(1) {
            break;
        }
        let (prefix, prefix_style, content_style) = if chunk.phase.contains("think") || chunk.phase.contains("reason") {
            ("↳ ", Style::new().fg(DIM), Style::new().fg(DIM).dim())
        } else {
            let col = worker_color(&chunk.coordinator);
            ("⬡ ", Style::new().fg(col).bold(), Style::new().fg(WHITE))
        };

        canvas.print(area.x + 1, y, prefix, prefix_style);
        let avail = area.w.saturating_sub(3) as usize;
        let shown: String = chunk.content.chars().take(avail).collect();
        canvas.print(area.x + 3, y, &shown, content_style);
        y += 1;
    }

    if chunks.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "esperando razonamiento...", Style::new().fg(DIM));
    }
}

fn render_filemap_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    let title = "⬡ MAPA DE ARCHIVOS · riesgo";
    canvas.print(area.x + 1, area.y, title, Style::new().fg(AMBER).bold());

    let avail_h = area.h.saturating_sub(2) as usize;
    let entries = &state.filemap.entries;

    if entries.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "sin archivos modificados", Style::new().fg(DIM));
        return;
    }

    let start = entries.len().saturating_sub(avail_h);
    let mut y = area.y + 1;

    for entry in entries.iter().skip(start) {
        if y >= area.bottom().saturating_sub(1) {
            break;
        }

        let (dot_color, risk_tag) = match entry.risk {
            RiskLevel::Low      => (GREEN,  "low "),
            RiskLevel::Medium   => (YELLOW, "med "),
            RiskLevel::High     => (AMBER,  "high"),
            RiskLevel::Critical => (RED,    "crit"),
        };

        canvas.print(area.x + 1, y, "●", Style::new().fg(dot_color).bold());
        canvas.print(area.x + 2, y, risk_tag, Style::new().fg(dot_color));

        let avail = area.w.saturating_sub(7) as usize;
        let path: String = entry.path.chars().take(avail).collect();
        canvas.print(area.x + 6, y, &path, Style::new().fg(SECONDARY));

        // agent tag on right
        if !entry.agent.is_empty() {
            let agent_col = worker_color(&entry.agent);
            let tag = format!("⬡{}", &entry.agent);
            let tag_x = area.right().saturating_sub(tag.chars().count() as u16 + 1);
            canvas.print(tag_x, y, &tag, Style::new().fg(agent_col));
        }

        y += 1;
    }

    // Bottom separator
    let sep_y = area.bottom().saturating_sub(1);
    let sep: String = std::iter::repeat('─').take(area.w.saturating_sub(2) as usize).collect();
    canvas.print(area.x + 1, sep_y, &sep, Style::new().fg(AMBER_DIM));
}

fn worker_color(name: &str) -> crate::term::Color {
    use crate::term::{AMBER_BRIGHT, BLUE, CYAN, LAVENDER, PINK, PURPLE, YELLOW};
    const ROLES: &[(&str, crate::term::Color)] = &[
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
