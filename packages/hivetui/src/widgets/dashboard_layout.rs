use crate::{
    state::{AppState, WorkerStatus},
    term::{
        Canvas, Rect, Style, AMBER, BG_ELEVATED, BG_PANEL, DIM, GREEN, RED, SECONDARY, YELLOW,
    },
    ui::{render_data_table, DataTable, TableAlign, TableCell, TableColumn, TableState},
    widgets::components::worker_color,
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let worker_area = if !state.tasks.tasks.is_empty() && area.h >= 10 {
        let task_h = ((state.tasks.tasks.len() as u16).saturating_add(2)).min(6).min(area.h / 3);
        let rows = area.vsplit(&[task_h, 0]);
        render_task_strip(canvas, rows[0], state);
        rows.get(1).copied().unwrap_or(area)
    } else {
        area
    };

    if state.workers.workers.is_empty() {
        render_empty(canvas, worker_area);
        return;
    }

    // Grid of worker cards
    // Each card: min 18 wide × 6 tall
    let card_w: u16 = 22;
    let card_h: u16 = 6;
    let cols_per_row = (worker_area.w / card_w).max(1);

    let mut idx = 0usize;
    for w in state.workers.workers.iter() {
        let col = (idx as u16) % cols_per_row;
        let row = (idx as u16) / cols_per_row;

        let cx = worker_area.x + col * card_w;
        let cy = worker_area.y + row * card_h;

        if cy + card_h > worker_area.bottom() {
            break;
        }

        let card = Rect::new(cx, cy, card_w.min(worker_area.right().saturating_sub(cx)), card_h);
        canvas.with_clip(card, |canvas| render_worker_card(canvas, card, w));
        idx += 1;
    }

    // Summary line at bottom
    let total = state.workers.workers.len();
    let running = state.workers.workers.iter().filter(|w| matches!(w.status, WorkerStatus::Running)).count();
    let summary = format!("⬡ {running}/{total} workers activos  ·  tokens:{}", fmt_tokens(state.session.token_count));
    let sy = worker_area.bottom().saturating_sub(1);
    canvas.print(worker_area.x + 1, sy, &summary, Style::new().fg(DIM));
}

fn render_task_strip(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    canvas.print(area.x + 1, area.y, "⬡ TAREAS · PROYECCIÓN", Style::new().fg(AMBER).bold());

    if area.h < 2 {
        return;
    }

    let columns = [
        TableColumn::fixed("estado", 12, TableAlign::Left),
        TableColumn::fill("tarea", 1, TableAlign::Left),
        TableColumn::fixed("workspace", 14, TableAlign::Right),
        TableColumn::fixed("workers", 18, TableAlign::Right),
    ];
    let active = state.tasks.active_task_id.as_deref();
    let rows: Vec<Vec<TableCell>> = state.tasks.tasks.iter().rev().take(area.h.saturating_sub(2) as usize).map(|task| {
        let is_active = active == Some(task.task_id.as_str());
        let marker = if is_active { "●" } else { "○" };
        let status = format!("{marker} {}", task.status);
        let workers = if task.active_workers.is_empty() {
            String::new()
        } else {
            task.active_workers.join(" · ")
        };
        let status_style = task_status_style(&task.status);
        let workspace = if task.isolated {
            match task.integration_status.as_deref() {
                Some("conflict") => format!("{} WT!", task.mode),
                Some("failed") => format!("{} WT?", task.mode),
                Some("integrated") => format!("{} WT✓", task.mode),
                Some(_) => format!("{} WT", task.mode),
                None => format!("{} WT", task.mode),
            }
        } else {
            task.mode.clone()
        };
        vec![
            TableCell::new(status, status_style),
            TableCell::new(task.title.clone(), Style::new().fg(SECONDARY)),
            TableCell::new(workspace, Style::new().fg(DIM)),
            TableCell::new(workers, Style::new().fg(DIM)),
        ]
    }).collect();

    render_data_table(
        canvas,
        Rect::new(area.x + 1, area.y + 1, area.w.saturating_sub(2), area.h.saturating_sub(1)),
        &columns,
        &rows,
        TableState::default(),
        &DataTable::default(),
    );
}

fn task_status_style(status: &str) -> Style {
    match status {
        "running" | "planning" | "approval" => Style::new().fg(GREEN).bold(),
        "completed" => Style::new().fg(DIM),
        "failed" => Style::new().fg(RED).bold(),
        "cancelled" | "paused" => Style::new().fg(YELLOW),
        _ => Style::new().fg(SECONDARY),
    }
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

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Worker;

    #[test]
    fn dashboard_renders_task_projection_strip() {
        let mut state = AppState::default();
        state.tasks.upsert(
            "task-1".to_string(),
            Some("Corregir login".to_string()),
            "running".to_string(),
            Some("auto".to_string()),
            Some(vec!["backend".to_string()]),
            None,
            None,
            None,
            None,
            None,
        );
        state.workers.workers.push(Worker {
            name: "backend".to_string(),
            display_name: "BackendEngineer".to_string(),
            status: WorkerStatus::Running,
            detail: Some("editando auth.ts".to_string()),
            activity: None,
        });

        let mut canvas = Canvas::new(100, 24);
        render(&mut canvas, Rect::new(0, 0, 100, 24), &state);
        let rows = canvas.to_text_rows();

        assert!(rows.iter().any(|row| row.contains("TAREAS")));
        assert!(rows.iter().any(|row| row.contains("Corregir login")));
        assert!(rows.iter().any(|row| row.contains("backend")));
    }
}
