use std::collections::HashMap;

use crate::{
    state::{AgentTier, AppState, WorkerStatus, agent_color, agent_display_name, tier_for},
    term::{Canvas, Rect, Style, AMBER, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM, GREEN, RED, SECONDARY, YELLOW},
    ui::{fmt_tokens, render_data_table, DataTable, TableAlign, TableCell, TableColumn, TableState},
};

const CARD_W: u16 = 26;
const CARD_H: u16 = 7;
const GAP: u16 = 1;
const TIER_GAP: u16 = 2;

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let (task_area, agent_area) = split_task_area(area, state);

    if task_area.h > 0 {
        render_task_strip(canvas, task_area, state);
    }

    if state.workers.workers.is_empty() {
        render_empty(canvas, agent_area);
        return;
    }

    // 1. Agrupar workers por tier
    let mut tier_workers: Vec<(AgentTier, Vec<&crate::state::Worker>)> = Vec::new();
    for tier in AgentTier::all() {
        let workers: Vec<_> = state.workers.workers.iter()
            .filter(|w| tier_for(&w.name) == *tier)
            .collect();
        if !workers.is_empty() {
            tier_workers.push((*tier, workers));
        }
    }

    if tier_workers.is_empty() {
        render_empty(canvas, agent_area);
        return;
    }

    // 2. Calcular layouts por tier
    let layouts = compute_tier_layouts(agent_area, &tier_workers);

    // 3. Dibujar conexiones ANTES de las tarjetas (capa inferior)
    let mut card_positions: HashMap<String, Rect> = HashMap::new();
    for (tier_idx, (_tier, workers)) in tier_workers.iter().enumerate() {
        let layout = &layouts[tier_idx];
        for (w_idx, worker) in workers.iter().enumerate() {
            if let Some(rect) = layout.cards.get(w_idx) {
                card_positions.insert(worker.name.clone(), *rect);
            }
        }
    }
    render_connections(canvas, &card_positions, state);

    // 4. Dibujar paneles de tier y tarjetas
    for (tier_idx, (tier, workers)) in tier_workers.iter().enumerate() {
        let layout = &layouts[tier_idx];
        // Fondo del tier
        canvas.fill_rect(layout.area, ' ', Style::new().bg(BG_PANEL));
        // Título del tier
        let title = format!(" ⬡ {} ", tier.label());
        canvas.print(layout.area.x + 1, layout.area.y, &title, Style::new().fg(AMBER_DIM).bold());

        let content_area = Rect::new(
            layout.area.x,
            layout.area.y + 1,
            layout.area.w,
            layout.area.h.saturating_sub(1),
        );

        // Tarjetas
        for (w_idx, worker) in workers.iter().enumerate() {
            if let Some(rect) = layout.cards.get(w_idx) {
                if rect.x >= content_area.x && rect.right() <= content_area.right() && rect.y >= content_area.y && rect.bottom() <= content_area.bottom() {
                    canvas.with_clip(*rect, |canvas| render_worker_card(canvas, *rect, worker));
                }
            }
        }
    }

    // 5. Summary line
    let total = state.workers.workers.len();
    let running = state.workers.workers.iter().filter(|w| matches!(w.status, WorkerStatus::Running)).count();
    let summary = format!("⬡ {running}/{total} workers activos  ·  tokens:{}", fmt_tokens(state.session.token_count));
    let sy = agent_area.bottom().saturating_sub(1);
    if sy >= agent_area.y {
        canvas.print(agent_area.x + 1, sy, &summary, Style::new().fg(DIM));
    }
}

fn split_task_area(area: Rect, state: &AppState) -> (Rect, Rect) {
    if !state.tasks.tasks.is_empty() && area.h >= 14 {
        let task_h = ((state.tasks.tasks.len() as u16).saturating_add(2)).min(6).min(area.h / 4);
        let top = Rect::new(area.x, area.y, area.w, task_h);
        let bottom = Rect::new(area.x, area.y + task_h, area.w, area.h.saturating_sub(task_h));
        (top, bottom)
    } else {
        (Rect::new(area.x, area.y, area.w, 0), area)
    }
}

struct TierLayout {
    area: Rect,
    cards: Vec<Rect>,
}

fn compute_tier_layouts(area: Rect, tier_workers: &[(AgentTier, Vec<&crate::state::Worker>)]) -> Vec<TierLayout> {
    let n_tiers = tier_workers.len() as u16;
    if n_tiers == 0 {
        return Vec::new();
    }

    // Calcular altura mínima por tier
    let inner_w = area.w;
    let mut min_heights: Vec<u16> = Vec::new();
    let mut total_min: u16 = 0;

    for (_tier, workers) in tier_workers {
        let cols = (inner_w / (CARD_W + GAP)).max(1);
        let rows = ((workers.len() as u16 + cols - 1) / cols).max(1);
        let min_h = rows * CARD_H + (rows.saturating_sub(1) * GAP) + 1; // +1 para título
        min_heights.push(min_h);
        total_min = total_min.saturating_add(min_h);
    }

    let gaps_total = (n_tiers.saturating_sub(1)) * TIER_GAP;
    let available_h = area.h.saturating_sub(gaps_total);
    let extra = available_h.saturating_sub(total_min);

    // Repartir espacio sobrante proporcionalmente
    let mut layouts = Vec::with_capacity(tier_workers.len());
    let mut y = area.y;

    for (idx, (_tier, workers)) in tier_workers.iter().enumerate() {
        let min_h = min_heights[idx];
        let grow = if total_min > 0 {
            (extra as u32 * min_h as u32 / total_min as u32) as u16
        } else {
            extra / n_tiers
        };
        let tier_h = min_h.saturating_add(grow).max(1);

        let tier_area = Rect::new(area.x, y, area.w, tier_h.min(area.bottom().saturating_sub(y)));
        y = y.saturating_add(tier_h).saturating_add(TIER_GAP);

        // Posicionar tarjetas dentro del tier
        let content_y = tier_area.y + 1; // después del título
        let content_h = tier_area.h.saturating_sub(1);
        let content_area = Rect::new(tier_area.x, content_y, tier_area.w, content_h);

        let cards = place_cards_in_area(content_area, workers.len() as u16);

        layouts.push(TierLayout { area: tier_area, cards });
    }

    layouts
}

fn place_cards_in_area(area: Rect, count: u16) -> Vec<Rect> {
    if count == 0 {
        return Vec::new();
    }
    let cols = (area.w / (CARD_W + GAP)).max(1);
    let mut rects = Vec::with_capacity(count as usize);
    for i in 0..count {
        let col = i % cols;
        let row = i / cols;
        let x = area.x + col * (CARD_W + GAP);
        let y = area.y + row * (CARD_H + GAP);
        if y + CARD_H > area.bottom() {
            // Fuera de bounds, pero añadir de todos modos con clip después
        }
        let w = CARD_W.min(area.right().saturating_sub(x));
        let h = CARD_H.min(area.bottom().saturating_sub(y));
        rects.push(Rect::new(x, y, w, h));
    }
    rects
}

fn render_connections(canvas: &mut Canvas, positions: &HashMap<String, Rect>, _state: &AppState) {
    use crate::state::{all_edges, tier_for};

    let line_style = Style::new().fg(AMBER_DIM);

    for (from, to) in all_edges() {
        let Some(from_rect) = positions.get(*from) else { continue };
        let Some(to_rect) = positions.get(*to) else { continue };

        // Solo conectar tiers adyacentes para evitar spaghetti
        let from_tier = tier_for(from);
        let to_tier = tier_for(to);
        if to_tier as u8 != from_tier as u8 + 1 {
            continue;
        }

        let x1 = from_rect.x + from_rect.w / 2;
        let y1 = from_rect.bottom().saturating_sub(1);
        let x2 = to_rect.x + to_rect.w / 2;
        let y2 = to_rect.y;

        if y2 <= y1 {
            continue;
        }

        // Manhattan routing: bajar verticalmente hasta la mitad, luego horizontal, luego vertical
        let mid_y = (y1 + y2) / 2;

        if x1 == x2 {
            // Línea recta vertical
            for y in y1..=y2 {
                canvas.print(x1, y, "│", line_style);
            }
            continue;
        }

        // Tramo vertical superior (sin incluir mid_y para no pisar la esquina)
        for y in y1..mid_y {
            canvas.print(x1, y, "│", line_style);
        }

        // Tramo horizontal con esquinas
        let (hx_start, hx_end) = if x1 < x2 { (x1, x2) } else { (x2, x1) };
        for x in hx_start..=hx_end {
            let ch = if x == x1 {
                if x1 < x2 { "┌" } else { "┐" }
            } else if x == x2 {
                if x1 < x2 { "┘" } else { "└" }
            } else {
                "─"
            };
            canvas.print(x, mid_y, ch, line_style);
        }

        // Tramo vertical inferior (sin incluir mid_y)
        for y in (mid_y + 1)..=y2 {
            canvas.print(x2, y, "│", line_style);
        }
    }
}

fn render_worker_card(canvas: &mut Canvas, area: Rect, w: &crate::state::Worker) {
    if area.w < 4 || area.h < 3 {
        return;
    }

    let wcolor = agent_color(&w.name);
    let bg = BG_ELEVATED;

    // Fondo con borde sutil
    canvas.fill_rect(area, ' ', Style::new().bg(bg));
    canvas.draw_border(area, Style::new().fg(wcolor).dim().bg(bg));

    // Esquinas decorativas
    canvas.print(area.x, area.y, "⬢", Style::new().fg(wcolor).bg(bg));
    if area.w > 2 {
        canvas.print(area.right().saturating_sub(1), area.y, "⬢", Style::new().fg(wcolor).bg(bg));
        canvas.print(area.x, area.bottom().saturating_sub(1), "⬢", Style::new().fg(wcolor).bg(bg));
        canvas.print(area.right().saturating_sub(1), area.bottom().saturating_sub(1), "⬢", Style::new().fg(wcolor).bg(bg));
    }

    let display = if w.display_name.is_empty() {
        agent_display_name(&w.name)
    } else {
        w.display_name.clone()
    };

    // Nombre
    let name_max = (area.w.saturating_sub(5)) as usize;
    let name_shown: String = display.chars().take(name_max).collect();
    canvas.print(area.x + 2, area.y + 1, &format!("⬡ {name_shown}"), Style::new().fg(wcolor).bold().bg(bg));

    // Status
    let (status_str, status_color) = match w.status {
        WorkerStatus::Running => ("● running", GREEN),
        WorkerStatus::Done    => ("✓ done",    GREEN),
        WorkerStatus::Failed  => ("✗ failed",  RED),
        WorkerStatus::Waiting => ("○ waiting", DIM),
        WorkerStatus::Warn    => ("⚠ warn",    YELLOW),
    };
    canvas.print(area.x + 2, area.y + 2, status_str, Style::new().fg(status_color).bold().bg(bg));

    // Detail / activity
    let detail_text = w.activity.as_deref().or(w.detail.as_deref()).unwrap_or("");
    if !detail_text.is_empty() && area.h > 4 {
        let avail = area.w.saturating_sub(5) as usize;
        let shown: String = detail_text.chars().take(avail).collect();
        canvas.print(area.x + 2, area.y + 3, &shown, Style::new().fg(SECONDARY).bg(bg));
    }

    // Extra detail si hay espacio
    if let Some(ref detail) = w.detail {
        if w.activity.is_some() && area.h > 5 {
            let avail = area.w.saturating_sub(5) as usize;
            let shown: String = detail.chars().take(avail).collect();
            canvas.print(area.x + 2, area.y + 4, &shown, Style::new().fg(DIM).bg(bg));
        }
    }
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

fn render_empty(canvas: &mut Canvas, area: Rect) {
    let msg = "⬡ sin workers registrados";
    let x = area.x + area.w.saturating_sub(msg.chars().count() as u16) / 2;
    let y = area.y + area.h / 2;
    canvas.print(x, y, msg, Style::new().fg(DIM));
    canvas.print(x, y + 1, "inicia una tarea para ver el dashboard", Style::new().fg(DIM));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AgentTier, Worker, tier_for};

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
        assert!(rows.iter().any(|row| row.contains("BackendEngineer")));
    }

    #[test]
    fn dashboard_draws_connections_when_multiple_tiers() {
        let mut state = AppState::default();
        state.workers.workers.push(Worker {
            name: "bee".to_string(),
            display_name: "Bee".to_string(),
            status: WorkerStatus::Running,
            detail: None,
            activity: None,
        });
        state.workers.workers.push(Worker {
            name: "architecture".to_string(),
            display_name: "Architecture".to_string(),
            status: WorkerStatus::Running,
            detail: None,
            activity: None,
        });
        state.workers.workers.push(Worker {
            name: "backend".to_string(),
            display_name: "BackendEngineer".to_string(),
            status: WorkerStatus::Running,
            detail: None,
            activity: None,
        });

        let mut canvas = Canvas::new(120, 40);
        render(&mut canvas, Rect::new(0, 0, 120, 40), &state);
        let rows = canvas.to_text_rows();

        // Debe aparecer algún carácter de conexión
        let has_connection = rows.iter().any(|row| {
            row.contains('│') || row.contains('─') || row.contains('┌') || row.contains('└') || row.contains('┐') || row.contains('┘')
        });
        assert!(has_connection, "debería dibujar conexiones entre tiers");
    }

    #[test]
    fn dashboard_wraps_cards_when_narrow() {
        let mut state = AppState::default();
        for i in 0..3 {
            state.workers.workers.push(Worker {
                name: format!("worker-{i}"),
                display_name: format!("Worker{i}"),
                status: WorkerStatus::Waiting,
                detail: None,
                activity: None,
            });
        }

        let mut canvas = Canvas::new(40, 30);
        render(&mut canvas, Rect::new(0, 0, 40, 30), &state);
        let rows = canvas.to_text_rows();

        // Debe haber más de una fila de tarjetas (ENGINEERING tier con wrap)
        assert!(rows.iter().any(|row| row.contains("Worker0")));
        assert!(rows.iter().any(|row| row.contains("Worker2")));
    }

    #[test]
    fn tier_grouping_is_correct() {
        assert_eq!(tier_for("bee"), AgentTier::Orchestrator);
        assert_eq!(tier_for("architecture"), AgentTier::Planning);
        assert_eq!(tier_for("backend"), AgentTier::Engineering);
        assert_eq!(tier_for("test"), AgentTier::Quality);
        assert_eq!(tier_for("reviewer"), AgentTier::Gate);
    }
}
