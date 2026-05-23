use crate::{
    state::{AppState, WorkerStatus},
    term::{
        Canvas, Rect, Style,
        AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, BG_PANEL, BLUE, CYAN,
        DIM, GREEN, LAVENDER, PINK, PURPLE, RED, SECONDARY, WHITE, YELLOW,
    },
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if area.w < 40 {
        return;
    }

    let active_workers = state.workers.workers.iter()
        .filter(|w| matches!(w.status, WorkerStatus::Running))
        .count();

    // Split dinámico: con 3+ workers activos, dar más espacio al panel de workers
    let left_w = if active_workers >= 3 {
        area.w * 40 / 100   // 40% diff, 60% workers
    } else {
        area.w * 60 / 100   // 60% diff, 40% workers
    };

    let cols = area.hsplit(&[left_w, 0]);
    render_diff_pane(canvas, cols[0], state);
    render_workers_pane(canvas, cols[1], state);
}

// ── Panel izquierdo: diff activo o filemap ────────────────────────────────────

fn render_diff_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if !state.diff.lines.is_empty() {
        render_diff_active(canvas, area, state);
    } else {
        render_filemap_fallback(canvas, area, state);
    }
}

fn render_diff_active(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.print(area.x + 1, area.y, "⬡ DIFF ·", Style::new().fg(AMBER_DIM));
    let path: String = state.diff.path
        .rsplit('/')
        .next()
        .unwrap_or(&state.diff.path)
        .chars()
        .take(area.w.saturating_sub(12) as usize)
        .collect();
    canvas.print(area.x + 10, area.y, &path, Style::new().fg(AMBER).bold());

    let avail_h = area.h.saturating_sub(2) as usize;
    let start = state.diff.scroll.min(state.diff.lines.len().saturating_sub(avail_h));
    let mut y = area.y + 1;

    for dl in state.diff.lines.iter().skip(start).take(avail_h) {
        if y >= area.bottom().saturating_sub(1) { break; }

        let (prefix, style) = match dl.kind.as_str() {
            "add"    => ("+", Style::new().fg(GREEN)),
            "remove" => ("-", Style::new().fg(RED)),
            _        => (" ", Style::new().fg(DIM)),
        };

        canvas.print(area.x + 1, y, prefix, style);
        let shown: String = dl.text.chars().take(area.w.saturating_sub(4) as usize).collect();
        canvas.print(area.x + 3, y, &shown, style);
        y += 1;
    }

    if state.diff.lines.len() > avail_h {
        let total = state.diff.lines.len();
        let pct = (start * 100) / total.max(1);
        let hint = format!("{}% · ↑↓", pct);
        canvas.print(area.right().saturating_sub(hint.len() as u16 + 1),
                     area.bottom().saturating_sub(1), &hint, Style::new().fg(DIM));
    }
}

fn render_filemap_fallback(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.print(area.x + 1, area.y, "⬡ ARCHIVOS MODIFICADOS", Style::new().fg(AMBER).bold());

    let avail_h = area.h.saturating_sub(2) as usize;
    let entries = &state.filemap.entries;

    if entries.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "sin cambios en curso", Style::new().fg(DIM));
        canvas.print(area.x + 2, area.y + 3,
            "Los diffs aparecerán aquí cuando los workers escriban archivos.",
            Style::new().fg(DIM));
        return;
    }

    let start = entries.len().saturating_sub(avail_h);
    let mut y = area.y + 1;

    for entry in entries.iter().skip(start) {
        if y >= area.bottom().saturating_sub(1) { break; }

        let dot_color = match entry.risk {
            crate::state::RiskLevel::Low      => GREEN,
            crate::state::RiskLevel::Medium   => YELLOW,
            crate::state::RiskLevel::High     => AMBER,
            crate::state::RiskLevel::Critical => RED,
        };
        canvas.print(area.x + 1, y, "●", Style::new().fg(dot_color).bold());
        let avail = area.w.saturating_sub(4) as usize;
        let path: String = entry.path.chars().take(avail).collect();
        canvas.print(area.x + 3, y, &path, Style::new().fg(WHITE));
        if !entry.operation.is_empty() {
            let op = format!("[{}]", entry.operation);
            let op_x = area.right().saturating_sub(op.chars().count() as u16 + 2);
            canvas.print(op_x, y, &op, Style::new().fg(DIM));
        }
        y += 1;
    }
}

// ── Panel derecho: todos los workers + checkpoint ─────────────────────────────

fn render_workers_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    // Si hay suficiente espacio, dar la mitad a workers y la otra al checkpoint
    let workers_h = if area.h > 8 { area.h * 65 / 100 } else { area.h };
    let panels = area.vsplit(&[workers_h, 0]);
    render_all_workers(canvas, panels[0], state);
    if area.h > 8 {
        render_checkpoint_card(canvas, panels[1], state);
    }
}

fn render_all_workers(canvas: &mut Canvas, area: Rect, state: &AppState) {
    let running_count = state.workers.workers.iter()
        .filter(|w| matches!(w.status, WorkerStatus::Running))
        .count();

    let title = if running_count > 0 {
        format!("⬡ WORKERS · {} activos", running_count)
    } else {
        "⬡ WORKERS · en espera".to_string()
    };
    canvas.print(area.x + 1, area.y, &title, Style::new().fg(CYAN).bold());

    if state.workers.workers.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "sin workers activos", Style::new().fg(DIM));
        return;
    }

    let mut y = area.y + 1;
    for w in state.workers.workers.iter() {
        if y >= area.bottom().saturating_sub(1) { break; }

        let (dot, dot_style) = match w.status {
            WorkerStatus::Running => ("●", Style::new().fg(GREEN).bold()),
            WorkerStatus::Done    => ("✓", Style::new().fg(GREEN)),
            WorkerStatus::Failed  => ("✗", Style::new().fg(RED)),
            WorkerStatus::Waiting => ("○", Style::new().fg(DIM)),
        };

        canvas.print(area.x + 1, y, dot, dot_style);
        let wcolor = worker_color(&w.name);
        canvas.print(area.x + 3, y, "⬡", Style::new().fg(wcolor));

        let max_name = (area.w.saturating_sub(10) as usize).min(10);
        let name: String = w.name.chars().take(max_name).collect();
        canvas.print(area.x + 5, y, &name, Style::new().fg(wcolor).bold());

        // Fase actual a la derecha (lo que está haciendo ahora)
        if let Some(ref detail) = w.detail {
            let name_end = area.x + 5 + name.len() as u16 + 1;
            let avail = area.right().saturating_sub(name_end + 1) as usize;
            if avail > 3 {
                let shown: String = detail.chars().take(avail).collect();
                canvas.print(name_end, y, &shown, Style::new().fg(SECONDARY));
            }
        }

        y += 1;
    }
}

fn render_checkpoint_card(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h < 3 { return; }

    let Some(cp) = state.checkpoints.entries.last() else {
        canvas.print(area.x + 1, area.y + 1, "sin checkpoints", Style::new().fg(DIM));
        return;
    };

    canvas.fill_rect(
        crate::term::Rect::new(area.x, area.y, area.w, area.h.min(5)),
        ' ',
        Style::new().bg(crate::term::BG_ELEVATED),
    );

    let time_part = if cp.time.is_empty() { String::new() } else { format!(" · {}", cp.time) };
    let header = format!("⬡ CHECKPOINT{time_part} ●");
    canvas.print(area.x + 1, area.y, &header, Style::new().fg(AMBER_BRIGHT).bold());

    let desc: String = cp.description.chars().take(area.w.saturating_sub(3) as usize).collect();
    canvas.print(area.x + 1, area.y + 1, &desc, Style::new().fg(SECONDARY));

    let files = format!("{} archivos  ⬡ {}", cp.file_count, cp.agent);
    canvas.print(area.x + 1, area.y + 2, &files, Style::new().fg(DIM));

    if area.h > 3 {
        canvas.print(area.x + 1, area.y + 3, "[↩ r] rollback", Style::new().fg(RED));
    }
}

fn worker_color(name: &str) -> crate::term::Color {
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
