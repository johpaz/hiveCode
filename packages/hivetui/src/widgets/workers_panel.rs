use crate::{
    state::{AppState, WorkerStatus},
    term::{Canvas, Rect, Style, CYAN, DIM, GREEN, RED, SECONDARY},
    widgets::welcome::worker_color as name_color,
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.draw_border(area, Style::new().fg(CYAN));
    canvas.print(area.x + 2, area.y, " workers ", Style::new().fg(CYAN).bold());

    if state.workers.workers.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "sin workers activos", Style::new().fg(DIM).dim());
        return;
    }

    for (i, w) in state.workers.workers.iter().enumerate() {
        let y = area.y + 1 + i as u16;
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

        let max_name = (area.w.saturating_sub(5) as usize).min(14);
        let name: String = w.name.chars().take(max_name).collect();
        canvas.print(area.x + 3, y, &name, Style::new().fg(name_color(&w.name)).bold());

        if let Some(ref detail) = w.detail {
            let detail_x = area.x + 3 + name.len() as u16 + 1;
            if detail_x < area.right().saturating_sub(1) {
                let avail = area.right().saturating_sub(detail_x + 1) as usize;
                let shown: String = detail.chars().take(avail).collect();
                canvas.print(detail_x, y, &shown, Style::new().fg(SECONDARY));
            }
        }
    }

    // Coordinator activo en la parte inferior
    if !state.workers.active_coordinator.is_empty() {
        let coord_y = area.bottom().saturating_sub(1);
        let coord_str = format!("↳ {}", state.workers.active_coordinator);
        let avail = area.w.saturating_sub(3) as usize;
        let shown: String = coord_str.chars().take(avail).collect();
        canvas.print(area.x + 1, coord_y, &shown, Style::new().fg(DIM));
    }
}
