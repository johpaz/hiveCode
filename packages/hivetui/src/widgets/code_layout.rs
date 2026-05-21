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

    // 60/40 split: left = diff view, right = workers + checkpoint card
    let left_w = area.w * 60 / 100;
    let cols = area.hsplit(&[left_w, 0]);
    render_diff_pane(canvas, cols[0], state);
    render_workers_pane(canvas, cols[1], state);
}

fn render_diff_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    // Header bar with file info
    canvas.print(area.x + 1, area.y, "⬡", Style::new().fg(AMBER_DIM));
    canvas.print(area.x + 3, area.y, "CAMBIOS RECIENTES", Style::new().fg(AMBER).bold());

    // Show file entries from filemap
    let avail_h = area.h.saturating_sub(2) as usize;
    let entries = &state.filemap.entries;

    if entries.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "sin cambios en curso", Style::new().fg(DIM));
        return;
    }

    let start = entries.len().saturating_sub(avail_h);
    let mut y = area.y + 1;

    for entry in entries.iter().skip(start) {
        if y >= area.bottom().saturating_sub(1) {
            break;
        }

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

        // op tag on right
        if !entry.operation.is_empty() {
            let op = format!("+{}", entry.operation);
            let op_x = area.right().saturating_sub(op.chars().count() as u16 + 2);
            canvas.print(op_x, y, &op, Style::new().fg(GREEN));
        }

        y += 1;
    }
}

fn render_workers_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    // Split into workers list (top ~60%) + checkpoint card (bottom ~40%)
    let workers_h = (area.h * 60 / 100).max(4);
    let panels = area.vsplit(&[workers_h, 0]);
    render_workers_list(canvas, panels[0], state);
    render_checkpoint_card(canvas, panels[1], state);
}

fn render_workers_list(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.print(area.x + 1, area.y, "⬡ WORKERS · estado live", Style::new().fg(CYAN).bold());

    if state.workers.workers.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "sin workers activos", Style::new().fg(DIM));
        return;
    }

    let mut y = area.y + 1;
    for w in state.workers.workers.iter() {
        if y >= area.bottom().saturating_sub(1) {
            break;
        }
        let (dot, dot_style) = match w.status {
            WorkerStatus::Running => ("●", Style::new().fg(GREEN).bold()),
            WorkerStatus::Done    => ("✓", Style::new().fg(GREEN)),
            WorkerStatus::Failed  => ("✗", Style::new().fg(RED)),
            WorkerStatus::Waiting => ("○", Style::new().fg(DIM)),
        };

        canvas.print(area.x + 1, y, dot, dot_style);
        let wcolor = worker_color(&w.name);
        canvas.print(area.x + 2, y, " ⬡ ", Style::new().fg(wcolor));

        let max_name = (area.w.saturating_sub(8) as usize).min(12);
        let name: String = w.name.chars().take(max_name).collect();
        canvas.print(area.x + 5, y, &name, Style::new().fg(wcolor).bold());

        if let Some(ref detail) = w.detail {
            let avail = area.w.saturating_sub(5 + name.chars().count() as u16 + 2) as usize;
            let shown: String = detail.chars().take(avail).collect();
            let dx = area.x + 5 + name.chars().count() as u16 + 1;
            canvas.print(dx, y, &shown, Style::new().fg(SECONDARY));
        }

        // state badge on right
        let state_str = match w.status {
            WorkerStatus::Running => "run",
            WorkerStatus::Done    => "done",
            WorkerStatus::Failed  => "fail",
            WorkerStatus::Waiting => "wait",
        };
        let state_x = area.right().saturating_sub(state_str.len() as u16 + 1);
        canvas.print(state_x, y, state_str, Style::new().fg(SECONDARY));

        y += 1;
    }
}

fn render_checkpoint_card(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h < 3 {
        return;
    }

    let Some(cp) = state.checkpoints.entries.last() else {
        canvas.print(area.x + 1, area.y + 1, "sin checkpoints", Style::new().fg(DIM));
        return;
    };

    // Card background
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
        let hint = "  · o presiona r";
        canvas.print(area.x + 1 + 14, area.y + 3, hint, Style::new().fg(DIM));
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
