use crate::{
    state::{AppState, RiskLevel},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM, GREEN, RED, SECONDARY, WHITE, YELLOW},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if area.h < 6 {
        return;
    }

    // Split: ADR view (fill) + approval strip (bottom ~6 rows)
    let strip_h = 6u16.min(area.h / 3);
    let panels = area.vsplit(&[0, strip_h]);
    render_adr_pane(canvas, panels[0], state);
    render_approval_strip(canvas, panels[1], state);
}

fn render_adr_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let title = "⬡ REVISIÓN · contexto de tarea";
    canvas.print(area.x + 1, area.y, title, Style::new().fg(AMBER).bold());

    let mut y = area.y + 1;
    let avail_w = area.w.saturating_sub(3) as usize;

    // Show thought stream chunks as "reasoning" display
    let chunks = &state.thought.chunks;
    let avail_h = area.h.saturating_sub(2) as usize;
    let start = chunks.len().saturating_sub(avail_h);

    for chunk in chunks.iter().skip(start) {
        if y >= area.bottom() {
            break;
        }
        let (prefix, ps, cs) = if chunk.phase.contains("think") || chunk.phase.contains("reason") {
            ("  ↳ ", Style::new().fg(DIM), Style::new().fg(DIM))
        } else {
            let col = worker_color(&chunk.coordinator);
            ("⬡  ", Style::new().fg(col).bold(), Style::new().fg(WHITE))
        };

        canvas.print(area.x + 1, y, prefix, ps);
        // prefix is 4 chars max
        let shown: String = chunk.content.chars().take(avail_w.saturating_sub(5)).collect();
        canvas.print(area.x + 5, y, &shown, cs);
        y += 1;
    }

    if chunks.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "sin actividad de revisión aún", Style::new().fg(DIM));
        canvas.print(area.x + 2, area.y + 4, "Los ADRs y contexto de los agentes", Style::new().fg(DIM));
        canvas.print(area.x + 2, area.y + 5, "aparecerán aquí durante la ejecución.", Style::new().fg(DIM));
    }
}

fn render_approval_strip(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    let file_count = state.filemap.entries.len();
    let header = format!("⬡ ARCHIVOS PARA APROBAR · {file_count}");
    canvas.print(area.x + 1, area.y, &header, Style::new().fg(AMBER_BRIGHT).bold());

    if state.filemap.entries.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "sin archivos pendientes de aprobación", Style::new().fg(DIM));
        return;
    }

    let mut y = area.y + 1;
    for entry in state.filemap.entries.iter().take(area.h.saturating_sub(3) as usize) {
        if y >= area.bottom().saturating_sub(2) {
            break;
        }
        let dot_color = match entry.risk {
            RiskLevel::Low      => GREEN,
            RiskLevel::Medium   => YELLOW,
            RiskLevel::High     => AMBER,
            RiskLevel::Critical => RED,
        };
        canvas.print(area.x + 1, y, "●", Style::new().fg(dot_color).bold());

        let avail = area.w.saturating_sub(4) as usize;
        let path: String = entry.path.chars().take(avail).collect();
        canvas.print(area.x + 3, y, &path, Style::new().fg(WHITE));
        y += 1;
    }

    // Hint
    let hint_y = area.bottom().saturating_sub(1);
    canvas.print(area.x + 1, hint_y, "→ ", Style::new().fg(AMBER_DIM));
    canvas.print(area.x + 3, hint_y, "/approve", Style::new().fg(AMBER).bold());
    canvas.print(area.x + 11, hint_y, " para aceptar  ·  ", Style::new().fg(DIM));
    canvas.print(area.x + 29, hint_y, "/reject <razón>", Style::new().fg(AMBER).bold());
    canvas.print(area.x + 44, hint_y, " para devolver", Style::new().fg(DIM));
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
