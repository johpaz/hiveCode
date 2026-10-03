use std::collections::{HashMap, HashSet};

use crate::{
    state::{
        agent_color, agent_display_name, tier_for, AgentTier, AppState, BlackboardEvent,
        DashboardLevelStatus, ModalState, ReplMode, Worker, WorkerStatus,
    },
    term::{
        Canvas, Color, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_CONFLICT, BG_ELEVATED,
        BG_MAIN, BG_PANEL, BLUE, CYAN, DIM, GREEN, RED, SECONDARY, WHITE, YELLOW,
    },
    ui::{fmt_tokens, truncate_cells},
    widgets::components::pulse_color,
};

const GAP: u16 = 1;
const ACTIVE_CARD_H: u16 = 8;

#[derive(Clone, Copy)]
struct DashboardAreas {
    header: Rect,
    pipeline: Rect,
    grid: Rect,
    feed: Rect,
    footer: Rect,
}

#[derive(Clone)]
struct CardPlacement {
    worker: String,
    rect: Rect,
}

#[derive(Clone)]
struct PipelineNode {
    label: &'static str,
    detail: String,
    status: DashboardLevelStatus,
}

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_MAIN));
    if area.w < 20 || area.h < 8 {
        render_tiny(canvas, area, state);
        return;
    }

    let areas = dashboard_areas(area);
    render_header(canvas, areas.header, state);
    render_pipeline(canvas, areas.pipeline, state);
    render_agent_grid(canvas, areas.grid, state);
    render_blackboard_feed(canvas, areas.feed, state);
    render_footer(canvas, areas.footer, state);
}

pub fn worker_at(state: &AppState, area: Rect, col: u16, row: u16) -> Option<String> {
    let areas = dashboard_areas(area);
    compute_card_placements(areas.grid, state)
        .into_iter()
        .find(|placement| contains(placement.rect, col, row))
        .map(|placement| placement.worker)
}

pub fn checkpoint_at(state: &AppState, area: Rect, col: u16, row: u16) -> Option<usize> {
    let areas = dashboard_areas(area);
    if row != areas.footer.y || col < areas.footer.x || col >= areas.footer.right() {
        return None;
    }
    let mut x = areas.footer.x.saturating_add(16);
    for (idx, label) in checkpoint_labels(state).into_iter().enumerate() {
        let w = label.chars().count() as u16;
        if col >= x && col < x.saturating_add(w) {
            return Some(idx);
        }
        x = x.saturating_add(w).saturating_add(1);
        if x >= areas.footer.right() {
            break;
        }
    }
    None
}

fn dashboard_areas(area: Rect) -> DashboardAreas {
    let header_h = area.h.min(1);
    let pipeline_h = area.h.saturating_sub(header_h).min(3);
    let footer_h = area.h.saturating_sub(header_h + pipeline_h).min(2);
    let body_h = area.h.saturating_sub(header_h + pipeline_h + footer_h);
    let grid_h = if body_h <= 1 {
        body_h
    } else {
        ((body_h as u32 * 5) / 8).max(1) as u16
    };
    let feed_h = body_h.saturating_sub(grid_h);

    DashboardAreas {
        header: Rect::new(area.x, area.y, area.w, header_h),
        pipeline: Rect::new(area.x, area.y + header_h, area.w, pipeline_h),
        grid: Rect::new(area.x, area.y + header_h + pipeline_h, area.w, grid_h),
        feed: Rect::new(area.x, area.y + header_h + pipeline_h + grid_h, area.w, feed_h),
        footer: Rect::new(
            area.x,
            area.bottom().saturating_sub(footer_h),
            area.w,
            footer_h,
        ),
    }
}

fn render_tiny(canvas: &mut Canvas, area: Rect, state: &AppState) {
    let mode = if state.dashboard.halt.active {
        "HALT"
    } else {
        state.session.mode.label()
    };
    let text = format!("⬡ hiveCode · DASHBOARD · {mode}");
    canvas.print(
        area.x + 1,
        area.y,
        &truncate_cells(&text, area.w.saturating_sub(2) as usize),
        Style::new().fg(AMBER_BRIGHT).bold().bg(BG_MAIN),
    );
}

fn render_header(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    let left = format!("⬡ hiveCode · {}", state.session.project_name);
    canvas.print(
        area.x + 1,
        area.y,
        &truncate_cells(&left, area.w.saturating_sub(3) as usize),
        Style::new().fg(AMBER_BRIGHT).bold().bg(BG_PANEL),
    );

    let (mode, mode_color) = if state.dashboard.halt.active {
        ("⬡ HALT".to_string(), pulse_color(RED, AMBER_BRIGHT, state.anim_tick))
    } else {
        match state.session.mode {
            ReplMode::Auto => ("AUTO".to_string(), GREEN),
            ReplMode::Approval => ("APPROVAL".to_string(), YELLOW),
            ReplMode::Plan => ("PLAN".to_string(), BLUE),
        }
    };
    let mode_x = area.x + area.w.saturating_sub(mode.chars().count() as u16) / 2;
    canvas.print(mode_x, area.y, &mode, Style::new().fg(mode_color).bold().bg(BG_PANEL));

    let elapsed = state
        .dashboard
        .metrics
        .elapsed_secs
        .map(format_elapsed)
        .unwrap_or_else(|| "--:--".to_string());
    let cost = if state.cost.is_empty() {
        "$0.00".to_string()
    } else {
        state.cost.clone()
    };
    let right = format!("tok {}  {cost}  {elapsed}", fmt_tokens(state.session.token_count));
    let right_x = area.right().saturating_sub(right.chars().count() as u16 + 1);
    if right_x > area.x + 1 {
        canvas.print(right_x, area.y, &right, Style::new().fg(SECONDARY).bg(BG_PANEL));
    }
}

fn render_pipeline(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new().bg(BG_MAIN));
    if area.h > 0 {
        canvas.print(area.x + 1, area.y, "PIPELINE", Style::new().fg(AMBER_DIM).bold());
    }
    if area.h < 2 {
        return;
    }

    let nodes = pipeline_nodes(state);
    let count = nodes.len().max(1) as u16;
    let usable_w = area.w.saturating_sub(2);
    let node_w = (usable_w / count).max(6);
    let y = area.y + 1;
    let mut last_color = DIM;

    for (idx, node) in nodes.iter().enumerate() {
        let x = area.x + 1 + idx as u16 * node_w;
        if idx > 0 {
            let connector_x = x.saturating_sub(2);
            if connector_x > area.x {
                canvas.print(connector_x, y, "─", Style::new().fg(last_color).bg(BG_MAIN));
            }
        }
        let color = level_color(node.status, state.anim_tick);
        let label = if node.detail.is_empty() {
            format!("[{}]", node.label)
        } else {
            format!("[{} {}]", node.label, node.detail)
        };
        canvas.print(
            x,
            y,
            &truncate_cells(&label, node_w.saturating_sub(2) as usize),
            Style::new().fg(color).bold().bg(BG_MAIN),
        );
        last_color = color;
    }

    if area.h >= 3 {
        let active = nodes
            .iter()
            .find(|node| node.status == DashboardLevelStatus::Active)
            .map(|node| format!("activo: {}", node.label))
            .unwrap_or_else(|| "activo: pendiente".to_string());
        canvas.print(
            area.x + 1,
            area.y + 2,
            &truncate_cells(&active, area.w.saturating_sub(2) as usize),
            Style::new().fg(DIM).bg(BG_MAIN),
        );
    }
}

fn render_agent_grid(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let security_w = if should_render_security_strip(state) && area.w > 30 { 1 } else { 0 };
    let grid_area = Rect::new(area.x, area.y, area.w.saturating_sub(security_w), area.h);
    let placements = compute_card_placements(area, state);

    if state.workers.workers.is_empty() {
        render_empty(canvas, grid_area);
    } else {
        render_conflict_lines(canvas, &placements, state);
        for placement in &placements {
            if let Some(worker) = worker_for_placement(state, &placement.worker) {
                render_worker_card(canvas, placement.rect, worker, state);
            }
        }
        render_inactive_summary(canvas, grid_area, state, &placements);
    }

    if security_w > 0 {
        render_security_strip(
            canvas,
            Rect::new(area.right().saturating_sub(1), area.y, 1, area.h),
            state,
        );
    }
}

fn render_blackboard_feed(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new().bg(BG_MAIN));
    canvas.print(area.x + 1, area.y, "BLACKBOARD", Style::new().fg(AMBER_DIM).bold());
    if area.h < 2 {
        return;
    }

    let events = if state.dashboard.blackboard_events.is_empty() {
        fallback_blackboard_events(state)
    } else {
        state.dashboard.blackboard_events.clone()
    };

    if events.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "sin eventos narrativos", Style::new().fg(DIM));
        return;
    }

    let max_rows = area.h.saturating_sub(1) as usize;
    let start = events.len().saturating_sub(max_rows);
    for (idx, event) in events.iter().skip(start).enumerate() {
        let y = area.y + 1 + idx as u16;
        if y >= area.bottom() {
            break;
        }
        render_blackboard_event(canvas, area, y, event);
    }
}

fn render_footer(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    render_checkpoint_line(canvas, Rect::new(area.x, area.y, area.w, 1), state);
    if area.h > 1 {
        render_controls_line(canvas, Rect::new(area.x, area.y + 1, area.w, 1), state);
    }
}

fn render_checkpoint_line(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.print(area.x + 1, area.y, "⬡ CHECKPOINTS", Style::new().fg(AMBER_DIM).bold().bg(BG_PANEL));
    if state.checkpoints.entries.is_empty() {
        canvas.print(area.x + 16, area.y, "sin checkpoints", Style::new().fg(DIM).bg(BG_PANEL));
        return;
    }

    let current_idx = state.checkpoints.entries.len().saturating_sub(1);
    let labels = checkpoint_labels(state);
    let mut x = area.x + 16;
    for (idx, label) in labels.iter().enumerate() {
        let checkpoint = &state.checkpoints.entries[idx];
        let style = if state.checkpoints.selected == Some(idx) {
            Style::new().fg(CYAN).bold().bg(BG_PANEL)
        } else if idx == current_idx {
            Style::new().fg(pulse_color(AMBER_BRIGHT, AMBER, state.anim_tick)).bold().bg(BG_PANEL)
        } else {
            Style::new().fg(SECONDARY).bg(BG_PANEL)
        };
        let shown = truncate_cells(label, area.right().saturating_sub(x + 1) as usize);
        if shown.is_empty() {
            break;
        }
        canvas.print(x, area.y, &shown, style);
        x = x.saturating_add(label.chars().count() as u16 + 1);
        if x >= area.right().saturating_sub(1) {
            break;
        }
        if state.dashboard.halt.checkpoint_id.as_deref() == Some(checkpoint.id.as_str()) {
            canvas.print(x.saturating_sub(1), area.y, "!", Style::new().fg(RED).bold().bg(BG_PANEL));
        }
    }
}

fn render_controls_line(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if let Some(confirm) = &state.dashboard.rollback_confirm_checkpoint {
        let msg = format!("CONFIRMAR ROLLBACK {confirm} · Enter confirma · Esc cancela");
        canvas.print(
            area.x + 1,
            area.y,
            &truncate_cells(&msg, area.w.saturating_sub(2) as usize),
            Style::new().fg(RED).bold().bg(BG_CONFLICT),
        );
        return;
    }

    if let ModalState::ReviewConfirm(confirm) = &state.modal {
        let msg = format!("confirmar {} del veredicto · Enter confirma · Esc cancela", confirm.action.label());
        canvas.print(
            area.x + 1,
            area.y,
            &truncate_cells(&msg, area.w.saturating_sub(2) as usize),
            Style::new().fg(AMBER_BRIGHT).bold().bg(BG_PANEL),
        );
        return;
    }

    let controls = if state.dashboard.halt.active {
        "HALT activo · selecciona checkpoint con ←/→ · Enter rollback"
    } else {
        match state.session.mode {
            ReplMode::Auto => "AUTO · Shift+Tab approval · Alt+h HALT · ←/→ checkpoint · Enter rollback",
            ReplMode::Approval => "APPROVAL · Alt+a aprobar · Alt+r rechazar · Alt+m modificar · ←/→ checkpoint",
            ReplMode::Plan => "PLAN · Enter iniciar ejecución · ←/→ checkpoint · Enter rollback si hay selección",
        }
    };
    let style = if state.dashboard.halt.active {
        Style::new().fg(RED).bold().bg(BG_PANEL)
    } else {
        Style::new().fg(SECONDARY).bg(BG_PANEL)
    };
    canvas.print(
        area.x + 1,
        area.y,
        &truncate_cells(controls, area.w.saturating_sub(2) as usize),
        style,
    );
}

fn checkpoint_labels(state: &AppState) -> Vec<String> {
    let current_idx = state.checkpoints.entries.len().saturating_sub(1);
    state
        .checkpoints
        .entries
        .iter()
        .enumerate()
        .map(|(idx, checkpoint)| {
            let prefix = if idx == current_idx { "●" } else { "↩" };
            let selected = if state.checkpoints.selected == Some(idx) { "◀" } else { "" };
            let level = worker_level_label(&checkpoint.agent);
            format!("[{prefix}{selected} {level} {}]", checkpoint.time)
        })
        .collect()
}

/// Separa los workers visibles en (activos, terminados, en espera). `None` si no
/// hay ninguno visible. Los activos son los que merecen tarjeta; el resto se colapsa.
fn partition_workers(state: &AppState) -> Option<(Vec<&Worker>, Vec<&Worker>, Vec<&Worker>)> {
    let visible: Vec<&Worker> = state
        .workers
        .workers
        .iter()
        .filter(|worker| !is_security_worker(worker))
        .filter(|worker| !is_replaced_worker(worker, state))
        .collect();
    if visible.is_empty() {
        return None;
    }

    let active_level = active_level(state);
    let mut active: Vec<&Worker> = visible
        .iter()
        .copied()
        .filter(|worker| is_active_worker(worker, active_level))
        .collect();
    if active.is_empty() {
        active = visible
            .iter()
            .copied()
            .filter(|worker| worker.status != WorkerStatus::Done)
            .collect();
    }
    let active_names: HashSet<&str> = active.iter().map(|worker| worker.name.as_str()).collect();
    let completed: Vec<&Worker> = visible
        .iter()
        .copied()
        .filter(|worker| worker.status == WorkerStatus::Done && !active_names.contains(worker.name.as_str()))
        .collect();
    let pending: Vec<&Worker> = visible
        .iter()
        .copied()
        .filter(|worker| worker.status == WorkerStatus::Waiting && !active_names.contains(worker.name.as_str()))
        .collect();
    Some((active, completed, pending))
}

fn compute_card_placements(area: Rect, state: &AppState) -> Vec<CardPlacement> {
    let security_w = if should_render_security_strip(state) && area.w > 30 { 1 } else { 0 };
    let area = Rect::new(area.x, area.y, area.w.saturating_sub(security_w), area.h);
    if area.w < 8 || area.h < 4 {
        return Vec::new();
    }

    let Some((active, completed, pending)) = partition_workers(state) else {
        return Vec::new();
    };

    // Los inactivos no ocupan tarjetas: se colapsan en 1-2 líneas al pie. Así las
    // tarjetas activas conservan su alto completo incluso en terminales de 30 filas.
    let summary_h = summary_height(completed.len(), pending.len(), area.h);
    let placements = place_active_cards(area, summary_h, &active);

    // Si algún activo se quedó fuera y no habíamos reservado línea de resumen,
    // reservamos una para poder nombrarlos en vez de que desaparezcan sin rastro.
    if placements.len() < active.len() && summary_h == 0 {
        return place_active_cards(area, 1, &active);
    }
    placements
}

/// Coloca las tarjetas de los workers activos en `area` menos las filas de resumen.
/// El reviewer, cuando está activo, se lleva una tarjeta ancha a la izquierda.
fn place_active_cards(area: Rect, summary_h: u16, active: &[&Worker]) -> Vec<CardPlacement> {
    let active_h = area.h.saturating_sub(summary_h);
    let active_area = Rect::new(area.x, area.y, area.w, active_h);
    let mut placements = Vec::new();

    if let Some(reviewer) = active.iter().find(|worker| worker.name == "reviewer").copied() {
        let reviewer_w = (active_area.w * 60 / 100).max(active_area.w.min(32));
        let reviewer_rect = Rect::new(
            active_area.x,
            active_area.y,
            reviewer_w.min(active_area.w),
            active_area.h.min(ACTIVE_CARD_H.max(active_area.h)),
        );
        placements.push(CardPlacement { worker: reviewer.name.clone(), rect: reviewer_rect });
        let rest: Vec<&Worker> = active
            .iter()
            .copied()
            .filter(|worker| worker.name != "reviewer")
            .collect();
        let rest_len = rest.len();
        let rest_area = Rect::new(
            active_area.x + reviewer_rect.w.saturating_add(GAP),
            active_area.y,
            active_area.w.saturating_sub(reviewer_rect.w.saturating_add(GAP)),
            active_area.h,
        );
        for (worker, rect) in rest.into_iter().zip(place_grid(rest_area, rest_len as u16, 24, ACTIVE_CARD_H)) {
            placements.push(CardPlacement { worker: worker.name.clone(), rect });
        }
    } else {
        for (worker, rect) in active
            .iter()
            .copied()
            .zip(place_grid(active_area, active.len() as u16, 28, ACTIVE_CARD_H))
        {
            placements.push(CardPlacement { worker: worker.name.clone(), rect });
        }
    }

    placements
}

/// Cuántas filas al pie del grid reserva el resumen de inactivos: una por categoría
/// no vacía, y ninguna si no queda sitio para al menos una tarjeta activa completa.
fn summary_height(completed: usize, pending: usize, area_h: u16) -> u16 {
    let wanted = u16::from(completed > 0) + u16::from(pending > 0);
    if wanted == 0 {
        return 0;
    }
    // El resumen tiene prioridad sobre las últimas filas de una tarjeta: saber que
    // hay 8 agentes ociosos vale más que una fila extra de detalle. Solo cede
    // cuando la tarjeta caería por debajo del piso de legibilidad.
    wanted.min(area_h.saturating_sub(MIN_CARD_H))
}

/// Dibuja al pie del grid el resumen colapsado de los agentes que no tienen tarjeta:
/// los terminados, los que esperan, y los activos que no cupieron.
fn render_inactive_summary(
    canvas: &mut Canvas,
    area: Rect,
    state: &AppState,
    placements: &[CardPlacement],
) {
    let Some((active, completed, pending)) = partition_workers(state) else {
        return;
    };

    let placed: HashSet<&str> = placements.iter().map(|p| p.worker.as_str()).collect();
    let overflow: Vec<&Worker> = active
        .into_iter()
        .filter(|worker| !placed.contains(worker.name.as_str()))
        .collect();

    // Debe coincidir con la reserva que hizo compute_card_placements.
    let summary_h = summary_height(completed.len(), pending.len(), area.h)
        .max(u16::from(!overflow.is_empty()));
    if summary_h == 0 || area.w < 4 {
        return;
    }

    let width = area.w.saturating_sub(2) as usize;
    let mut y = area.bottom().saturating_sub(summary_h);
    let lines = summary_lines(&overflow, &completed, &pending, width);
    for (line, color) in lines.into_iter().take(summary_h as usize) {
        canvas.print(area.x + 1, y, &line, Style::new().fg(color).bg(BG_PANEL));
        y += 1;
    }
}

/// `✓ 4 done: architect · pm · qa · devops` — una línea por categoría, truncada.
/// El overflow de activos va primero porque es lo que el usuario está esperando ver.
fn summary_lines(
    overflow: &[&Worker],
    completed: &[&Worker],
    pending: &[&Worker],
    width: usize,
) -> Vec<(String, Color)> {
    let mut out = Vec::new();
    for (icon, label, group, color) in [
        ('●', "más", overflow, BLUE),
        ('✓', "done", completed, GREEN),
        ('○', "idle", pending, DIM),
    ] {
        if group.is_empty() {
            continue;
        }
        let names: Vec<String> = group.iter().map(|w| agent_display_name(&w.name)).collect();
        let line = format!("{icon} {} {label}: {}", group.len(), names.join(" · "));
        out.push((truncate_cells(&line, width), color));
    }
    out
}

/// Alto por debajo del cual una tarjeta deja de ser legible (borde + nombre +
/// estado + intención). Antes que comprimir bajo este piso, se muestran menos
/// tarjetas y las restantes caen al resumen colapsado.
const MIN_CARD_H: u16 = 5;

fn place_grid(area: Rect, count: u16, min_w: u16, card_h: u16) -> Vec<Rect> {
    if count == 0 || area.w < 4 || area.h < 3 {
        return Vec::new();
    }
    let cols = count.min(((area.w + GAP) / (min_w + GAP)).max(1));
    let rows_needed = ((count + cols - 1) / cols).max(1);
    // Cuántas filas caben sin bajar del piso de legibilidad.
    let floor = MIN_CARD_H.min(area.h);
    let rows_fit = ((area.h + GAP) / (card_h.max(floor) + GAP)).max(1);
    let rows = rows_needed.min(rows_fit);
    let h = card_h
        .min((area.h.saturating_sub(rows.saturating_sub(1) * GAP)) / rows)
        .max(floor);
    let count = count.min(rows.saturating_mul(cols));
    let mut rects = Vec::with_capacity(count as usize);
    for idx in 0..count {
        let row = idx / cols;
        let col = idx % cols;
        let row_count = (count - row * cols).min(cols).max(1);
        let available_w = area.w.saturating_sub(row_count.saturating_sub(1) * GAP);
        let w = (available_w / row_count).max(4);
        let x = area.x + col * (w + GAP);
        let y = area.y + row * (h + GAP);
        if y >= area.bottom() {
            break;
        }
        rects.push(Rect::new(
            x,
            y,
            w.min(area.right().saturating_sub(x)),
            h.min(area.bottom().saturating_sub(y)),
        ));
    }
    rects
}

fn render_worker_card(canvas: &mut Canvas, area: Rect, worker: &Worker, state: &AppState) {
    if area.w < 4 || area.h < 3 {
        return;
    }
    let conflicted = worker_has_conflict(worker, state);
    let forensic = worker.replaces_worker.is_some();
    let status_color = if conflicted {
        pulse_color(RED, AMBER_BRIGHT, state.anim_tick)
    } else if forensic {
        pulse_color(YELLOW, AMBER_BRIGHT, state.anim_tick)
    } else {
        worker_status_color(worker.status, state.anim_tick)
    };
    let verdict_bg = reviewer_verdict_bg(worker, state).unwrap_or(BG_ELEVATED);
    canvas.fill_rect(area, ' ', Style::new().bg(verdict_bg));
    canvas.draw_border(area, Style::new().fg(status_color).bg(verdict_bg));

    let display = worker_display_name(worker);
    let title = if worker.replaces_worker.is_some() {
        "@FORENSICAGENT".to_string()
    } else {
        format!("@{}", display.to_ascii_uppercase())
    };
    canvas.print(area.x + 1, area.y, "⬡", Style::new().fg(status_color).bold().bg(verdict_bg));
    canvas.print(
        area.x + 3,
        area.y,
        &truncate_cells(&title, area.w.saturating_sub(6) as usize),
        Style::new().fg(agent_color(&worker.name)).bold().bg(verdict_bg),
    );
    if conflicted && area.w > 8 {
        canvas.print(area.right().saturating_sub(3), area.y, "!!", Style::new().fg(RED).bold().bg(verdict_bg));
    }

    let intent = worker
        .current_action
        .as_deref()
        .or(worker.activity.as_deref())
        .or(worker.detail.as_deref())
        .unwrap_or("esperando siguiente acción");
    if area.h > 2 {
        canvas.print(
            area.x + 2,
            area.y + 2,
            &truncate_cells(intent, area.w.saturating_sub(4) as usize),
            Style::new().fg(WHITE).bg(verdict_bg),
        );
    }
    if area.h > 3 {
        let file = worker.current_file.as_deref().unwrap_or("sin archivo activo");
        canvas.print(
            area.x + 2,
            area.y + 3,
            &truncate_cells(file, area.w.saturating_sub(4) as usize),
            Style::new().fg(SECONDARY).bg(verdict_bg),
        );
    }
    if area.h > 5 {
        let bar = iteration_bar(worker);
        canvas.print(area.x + 2, area.y + 5, &bar, Style::new().fg(AMBER).bg(verdict_bg));
    }
    if area.h > 6 {
        let tokens = format!("tokens {}", fmt_tokens(worker.token_count));
        let x = area.right().saturating_sub(tokens.chars().count() as u16 + 2);
        if x > area.x + 2 {
            canvas.print(x, area.bottom().saturating_sub(2), &tokens, Style::new().fg(DIM).bg(verdict_bg));
        }
    }
}

fn render_conflict_lines(canvas: &mut Canvas, placements: &[CardPlacement], state: &AppState) {
    let positions: HashMap<&str, Rect> = placements
        .iter()
        .map(|placement| (placement.worker.as_str(), placement.rect))
        .collect();
    for conflict in &state.conflicts.entries {
        let Some(a) = positions.get(conflict.agent_a.as_str()) else { continue };
        let Some(b) = positions.get(conflict.agent_b.as_str()) else { continue };
        let y = (a.y + b.y) / 2;
        let x1 = a.x + a.w / 2;
        let x2 = b.x + b.w / 2;
        let (start, end) = if x1 <= x2 { (x1, x2) } else { (x2, x1) };
        for x in start..=end {
            canvas.print(x, y, "─", Style::new().fg(RED).bg(BG_PANEL));
        }
    }
}

fn render_security_strip(canvas: &mut Canvas, area: Rect, state: &AppState) {
    let veto = state.dashboard.security.status.to_ascii_uppercase().contains("VETO")
        || state.conflicts.entries.iter().any(|conflict| {
            conflict.agent_a == "security" || conflict.agent_b == "security"
        });
    let color = if veto {
        pulse_color(RED, AMBER_BRIGHT, state.anim_tick)
    } else {
        GREEN
    };
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    let label = if veto { "VETO ACTIVO" } else { "WATCHING" };
    for (idx, ch) in label.chars().enumerate() {
        let y = area.y + idx as u16;
        if y >= area.bottom() {
            break;
        }
        canvas.print(area.x, y, &ch.to_string(), Style::new().fg(color).bold().bg(BG_ELEVATED));
    }
    if area.h > 2 {
        let findings = state.dashboard.security.findings.to_string();
        canvas.print(area.x, area.bottom().saturating_sub(1), &findings.chars().next().unwrap_or('0').to_string(), Style::new().fg(color).bold().bg(BG_ELEVATED));
    }
}

fn render_blackboard_event(canvas: &mut Canvas, area: Rect, y: u16, event: &BlackboardEvent) {
    let (fg, bg) = event_style(&event.event_type);
    if bg.is_some() {
        canvas.fill_rect(Rect::new(area.x, y, area.w, 1), ' ', Style::new().bg(bg.unwrap()));
    }
    let agent = truncate_cells(&event.agent, 12);
    let line = format!(
        "{} {} [{}] {}",
        event.timestamp,
        agent,
        event.event_type.to_ascii_uppercase(),
        event.content
    );
    canvas.print(
        area.x + 1,
        y,
        &truncate_cells(&line, area.w.saturating_sub(2) as usize),
        Style::new().fg(fg).bg(bg.unwrap_or(BG_MAIN)),
    );
}

fn fallback_blackboard_events(state: &AppState) -> Vec<BlackboardEvent> {
    let mut events: Vec<BlackboardEvent> = state
        .thought
        .chunks
        .iter()
        .rev()
        .take(20)
        .map(|chunk| BlackboardEvent {
            timestamp: state.clock.clone(),
            agent: chunk.coordinator.clone(),
            event_type: "OBSERVATION".to_string(),
            content: chunk.content.clone(),
        })
        .collect();
    events.reverse();
    events
}

fn pipeline_nodes(state: &AppState) -> Vec<PipelineNode> {
    let labels = [
        (0, "PM"),
        (1, "ARC"),
        (2, "ENG"),
        (3, "QA+SEC"),
        (4, "OPS"),
        (5, "REV"),
        (6, "LIB"),
    ];
    let active = active_level(state).unwrap_or(0);
    labels
        .into_iter()
        .map(|(level, label)| {
            let explicit = state.dashboard.levels.iter().find(|entry| entry.level == level);
            let status = explicit
                .map(|entry| entry.status)
                .unwrap_or_else(|| inferred_level_status(level, active, state));
            let detail = if label == "ENG" {
                engineer_detail(state)
            } else {
                explicit
                    .map(|entry| entry.agents.iter().map(|agent| abbrev(agent)).collect::<Vec<_>>().join("|"))
                    .unwrap_or_default()
            };
            PipelineNode { label, detail, status }
        })
        .collect()
}

fn inferred_level_status(level: u32, active: u32, state: &AppState) -> DashboardLevelStatus {
    if state.workers.workers.iter().any(|worker| worker.level == Some(level) && worker.status == WorkerStatus::Running) {
        DashboardLevelStatus::Active
    } else if state.workers.workers.iter().any(|worker| worker.level == Some(level) && worker.status == WorkerStatus::Done) || level < active {
        DashboardLevelStatus::Done
    } else if level == active && state.workers.workers.iter().any(|worker| worker.status == WorkerStatus::Running) {
        DashboardLevelStatus::Active
    } else {
        DashboardLevelStatus::Pending
    }
}

fn active_level(state: &AppState) -> Option<u32> {
    state
        .dashboard
        .levels
        .iter()
        .find(|level| level.status == DashboardLevelStatus::Active)
        .map(|level| level.level)
        .or_else(|| {
            state
                .workers
                .workers
                .iter()
                .filter(|worker| worker.status == WorkerStatus::Running)
                .filter_map(|worker| worker.level.or_else(|| Some(tier_to_level(tier_for(&worker.name)))))
                .min()
        })
}

fn tier_to_level(tier: AgentTier) -> u32 {
    match tier {
        AgentTier::Orchestrator => 0,
        AgentTier::Planning => 1,
        AgentTier::Engineering => 2,
        AgentTier::Quality => 3,
        AgentTier::Gate => 5,
        AgentTier::OnDemand => 6,
    }
}

fn engineer_detail(state: &AppState) -> String {
    let mut agents: Vec<String> = state
        .workers
        .workers
        .iter()
        .filter(|worker| tier_for(&worker.name) == AgentTier::Engineering)
        .map(|worker| abbrev(&worker.name))
        .collect();
    agents.sort();
    agents.dedup();
    if agents.is_empty() {
        String::new()
    } else {
        agents.join("|")
    }
}

fn abbrev(agent: &str) -> String {
    match agent {
        "product_manager" => "PM".to_string(),
        "architecture" | "architect" => "ARC".to_string(),
        "backend" => "BE".to_string(),
        "frontend" => "FE".to_string(),
        "data_scientist" => "DS".to_string(),
        "security" => "SEC".to_string(),
        "test" => "QA".to_string(),
        "devops" => "OPS".to_string(),
        "verifier" => "VER".to_string(),
        "reviewer" => "REV".to_string(),
        "librarian" => "LIB".to_string(),
        _ => agent.chars().take(3).collect::<String>().to_ascii_uppercase(),
    }
}

fn is_active_worker(worker: &Worker, active_level: Option<u32>) -> bool {
    matches!(worker.status, WorkerStatus::Running | WorkerStatus::Failed | WorkerStatus::Warn)
        || active_level.is_some_and(|level| worker.level.unwrap_or_else(|| tier_to_level(tier_for(&worker.name))) == level)
}

fn is_security_worker(worker: &Worker) -> bool {
    worker.name == "security" || worker.display_name.to_ascii_lowercase().contains("securityauditor")
}

fn is_replaced_worker(worker: &Worker, state: &AppState) -> bool {
    state
        .workers
        .workers
        .iter()
        .any(|candidate| candidate.replaces_worker.as_deref() == Some(worker.name.as_str()))
}

fn should_render_security_strip(state: &AppState) -> bool {
    state.dashboard.security.status != "OFFLINE"
        || state.workers.workers.iter().any(is_security_worker)
}

fn worker_for_placement<'a>(state: &'a AppState, name: &str) -> Option<&'a Worker> {
    state.workers.workers.iter().find(|worker| worker.name == name)
}

fn worker_has_conflict(worker: &Worker, state: &AppState) -> bool {
    state.conflicts.entries.iter().any(|conflict| {
        conflict.agent_a == worker.name
            || conflict.agent_b == worker.name
            || worker.replaces_worker.as_deref() == Some(conflict.agent_a.as_str())
            || worker.replaces_worker.as_deref() == Some(conflict.agent_b.as_str())
    })
}

fn reviewer_verdict_bg(worker: &Worker, state: &AppState) -> Option<Color> {
    if worker.name != "reviewer" || worker.status == WorkerStatus::Running {
        return None;
    }
    let verdict = state.review.verdict.as_ref()?;
    let status = verdict.status.to_ascii_lowercase();
    if status.contains("approved") || status.contains("aprobado") || status.contains("pass") {
        Some(Color::Rgb { r: 7, g: 45, b: 25 })
    } else if status.contains("reject") || status.contains("rechaz") || status.contains("fail") {
        Some(BG_CONFLICT)
    } else {
        None
    }
}

fn worker_display_name(worker: &Worker) -> String {
    if worker.display_name.trim().is_empty() {
        agent_display_name(&worker.name)
    } else {
        worker.display_name.clone()
    }
}


fn worker_status_color(status: WorkerStatus, tick: u8) -> Color {
    match status {
        WorkerStatus::Running => pulse_color(BLUE, AMBER_BRIGHT, tick),
        WorkerStatus::Done => GREEN,
        WorkerStatus::Failed => pulse_color(RED, AMBER_BRIGHT, tick),
        WorkerStatus::Warn => YELLOW,
        WorkerStatus::Waiting => DIM,
    }
}

fn level_color(status: DashboardLevelStatus, tick: u8) -> Color {
    match status {
        DashboardLevelStatus::Done => GREEN,
        DashboardLevelStatus::Active => pulse_color(BLUE, AMBER_BRIGHT, tick),
        DashboardLevelStatus::Pending => DIM,
    }
}

fn iteration_bar(worker: &Worker) -> String {
    let total = worker.iteration_total.unwrap_or(5).clamp(1, 12);
    let current = worker.iteration_current.unwrap_or(0).min(total);
    let mut out = String::from("iter ");
    for idx in 0..total {
        out.push(if idx < current { '■' } else { '□' });
    }
    out
}

fn worker_level_label(agent: &str) -> String {
    match tier_for(agent) {
        AgentTier::Orchestrator => "L0".to_string(),
        AgentTier::Planning => "L1".to_string(),
        AgentTier::Engineering => "L2".to_string(),
        AgentTier::Quality => "L3".to_string(),
        AgentTier::Gate => "L5".to_string(),
        AgentTier::OnDemand => "LIB".to_string(),
    }
}

fn event_style(event_type: &str) -> (Color, Option<Color>) {
    match event_type.to_ascii_uppercase().as_str() {
        "DECISION" => (YELLOW, None),
        "OBSERVATION" => (SECONDARY, None),
        "CONSTRAINT" => (AMBER, None),
        "CONFLICT" => (RED, Some(BG_CONFLICT)),
        "RESOLVED" => (GREEN, None),
        "FORENSIC" => (AMBER_BRIGHT, None),
        "VETO" | "HALT" => (RED, Some(BG_CONFLICT)),
        _ => (WHITE, None),
    }
}

fn render_empty(canvas: &mut Canvas, area: Rect) {
    let msg = "⬡ sin workers registrados";
    let x = area.x + area.w.saturating_sub(msg.chars().count() as u16) / 2;
    let y = area.y + area.h / 2;
    canvas.print(x, y, msg, Style::new().fg(DIM).bg(BG_PANEL));
}

fn format_elapsed(seconds: u64) -> String {
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn contains(rect: Rect, col: u16, row: u16) -> bool {
    col >= rect.x && col < rect.right() && row >= rect.y && row < rect.bottom()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{BlackboardEvent, Checkpoint, DashboardLevel, Worker};

    fn worker(name: &str, status: WorkerStatus) -> Worker {
        let mut worker = Worker::new(name);
        worker.display_name = agent_display_name(name);
        worker.status = status;
        worker.current_action = Some("implementando endpoint de refresh token".to_string());
        worker.current_file = Some("src/auth.ts".to_string());
        worker.iteration_current = Some(2);
        worker.iteration_total = Some(5);
        worker.token_count = 12_000;
        worker
    }

    #[test]
    fn dashboard_renders_five_bands_without_input_chrome() {
        let mut state = AppState::default();
        state.session.project_name = "demo".to_string();
        state.workers.workers.push(worker("backend", WorkerStatus::Running));
        state.workers.workers.push(worker("frontend", WorkerStatus::Running));
        state.dashboard.blackboard_events.push(BlackboardEvent {
            timestamp: "12:00:01".to_string(),
            agent: "architecture".to_string(),
            event_type: "DECISION".to_string(),
            content: "usar contrato shared".to_string(),
        });

        let mut canvas = Canvas::new(120, 32);
        render(&mut canvas, Rect::new(0, 0, 120, 32), &state);
        let rows = canvas.to_text_rows().join("\n");

        assert!(rows.contains("⬡ hiveCode"));
        assert!(rows.contains("PIPELINE"));
        assert!(rows.contains("BLACKBOARD"));
        assert!(rows.contains("CHECKPOINTS"));
        assert!(!rows.contains("shift+tab"));
    }

    #[test]
    fn dashboard_pipeline_uses_level_state() {
        let mut state = AppState::default();
        state.dashboard.levels = vec![
            DashboardLevel { level: 0, label: "PM".to_string(), agents: vec!["product_manager".to_string()], status: DashboardLevelStatus::Done },
            DashboardLevel { level: 1, label: "Architecture".to_string(), agents: vec!["architecture".to_string()], status: DashboardLevelStatus::Active },
        ];

        let mut canvas = Canvas::new(100, 16);
        render(&mut canvas, Rect::new(0, 0, 100, 16), &state);
        let rows = canvas.to_text_rows().join("\n");

        assert!(rows.contains("[PM"));
        assert!(rows.contains("[ARC"));
        assert!(rows.contains("activo: ARC"));
    }

    #[test]
    fn dashboard_cards_show_intent_file_iterations_and_tokens() {
        let mut state = AppState::default();
        state.workers.workers.push(worker("backend", WorkerStatus::Running));

        let mut canvas = Canvas::new(100, 24);
        render(&mut canvas, Rect::new(0, 0, 100, 24), &state);
        let rows = canvas.to_text_rows().join("\n");

        assert!(rows.contains("@BACKENDENGINEER"));
        assert!(rows.contains("implementando endpoint"));
        assert!(rows.contains("src/auth.ts"));
        assert!(rows.contains("iter"));
        assert!(rows.contains("12.0k"));
    }

    #[test]
    fn dashboard_renders_security_forensic_conflict_and_halt_states() {
        let mut state = AppState::default();
        let mut failed = worker("backend", WorkerStatus::Failed);
        failed.current_action = Some("falló compilación".to_string());
        state.workers.workers.push(failed);
        let mut forensic = worker("forensic:backend", WorkerStatus::Warn);
        forensic.display_name = "ForensicAgent".to_string();
        forensic.replaces_worker = Some("backend".to_string());
        state.workers.workers.push(forensic);
        state.workers.workers.push(worker("security", WorkerStatus::Running));
        state.dashboard.security.status = "VETO ACTIVO".to_string();
        state.dashboard.security.findings = 3;
        state.dashboard.halt.active = true;

        let mut canvas = Canvas::new(120, 28);
        render(&mut canvas, Rect::new(0, 0, 120, 28), &state);
        let rows = canvas.to_text_rows().join("\n");

        assert!(rows.contains("⬡ HALT"));
        assert!(rows.contains("@FORENSICAGENT"));
        assert!(rows.contains("V"));
        assert!(!rows.contains("@BACKENDENGINEER"));
    }

    #[test]
    fn dashboard_worker_hit_testing_returns_clicked_worker() {
        let mut state = AppState::default();
        state.workers.workers.push(worker("backend", WorkerStatus::Running));
        let hit = worker_at(&state, Rect::new(0, 0, 100, 24), 3, 5);
        assert_eq!(hit.as_deref(), Some("backend"));
    }

    #[test]
    fn dashboard_checkpoint_hit_testing_returns_selected_index() {
        let mut state = AppState::default();
        state.checkpoints.entries.push(Checkpoint {
            id: "cp-1".to_string(),
            description: "level 1".to_string(),
            file_count: 1,
            agent: "backend".to_string(),
            time: "12:00".to_string(),
            tests_passed: 0,
            tests_total: 0,
        });

        let hit = checkpoint_at(&state, Rect::new(0, 0, 100, 24), 18, 22);
        assert_eq!(hit, Some(0));
    }
}
