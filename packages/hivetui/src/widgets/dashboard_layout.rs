use std::collections::{HashMap, HashSet};

use crate::{
    state::{
        agent_display_name, tier_for, AgentTier, AppState, BlackboardEvent,
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

    // Pulso del enjambre: cuántos trabajos y cuántos detenidos. La distinction
    // importa — "3 corriendo" y "nadie avanza" se veían igual.
    let pulse = swarm_pulse(state);
    if let Some((text, color)) = pulse {
        let x = area.x + left.chars().count() as u16 + 3;
        if x + text.chars().count() as u16 + 1 < mode_x {
            canvas.print(x, area.y, &text, Style::new().fg(color).bg(BG_PANEL));
        }
    }

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

/// El pulso del enjambre en una línea, o `None` cuando no hay nada que decir.
///
/// Prioriza la espera sobre el trabajo: si algo está detenido, eso es lo que el
/// usuario necesita ver primero, aunque haya otras tools corriendo.
fn swarm_pulse(state: &AppState) -> Option<(String, Color)> {
    let working = state.swarm.orphaned_calls();
    let waiting = state.swarm.waiting.len();
    if working == 0 && waiting == 0 {
        return None;
    }
    // La espera gana: si algo está detenido, es lo que hay que mirar aunque haya
    // otras herramientas corriendo.
    if waiting > 0 {
        let part = format!("○ {waiting} en espera");
        return Some(if working > 0 {
            (format!("⚙ {working}  {part}"), YELLOW)
        } else {
            (part, YELLOW)
        });
    }
    Some((
        format!("⚙ {working} trabajando"),
        pulse_color(GREEN, AMBER_BRIGHT, state.anim_tick),
    ))
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
        Style::new().fg(crate::ui::Theme::worker(&worker.name)).bold().bg(verdict_bg),
    );
    if conflicted && area.w > 8 {
        canvas.print(area.right().saturating_sub(3), area.y, "!!", Style::new().fg(RED).bold().bg(verdict_bg));
    }

    // La línea de intención ahora sale de la telemetría: qué tool corre, con qué
    // argumentos, y en qué color según lo que hace. `current_action` queda de
    // reserva para los agentes legacy.
    let (live, live_color) = agent_live_line(state, worker);
    if area.h > 2 {
        canvas.print(
            area.x + 2,
            area.y + 2,
            &truncate_cells(&live, area.w.saturating_sub(4) as usize),
            Style::new().fg(live_color).bg(verdict_bg),
        );
    }
    // La espera se marca en el borde: es lo que el usuario tiene que notar de un
    // vistazo, y un texto pequeño en la tarjeta no basta.
    let waiting = state.swarm.waiting.contains_key(&worker.name);
    if waiting && area.w > 10 && area.h > 3 {
        let chip = format!(" ⏳ {} ", state.swarm.waiting[&worker.name].reason_label());
        canvas.print(
            area.right().saturating_sub(chip.chars().count() as u16 + 1),
            area.y,
            &chip,
            Style::new().fg(BG_PANEL).bg(YELLOW).bold(),
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

/// Qué está haciendo este agente **ahora**, según la telemetría.
///
/// Antes esta tarjeta caía en `current_action`, que el backend llenaba con
/// `"ejecutando <phase>"` — un texto que no decía qué herramienta corría. Ahora
/// la fuente primaria es la llamada en vuelo real; `current_action` queda como
/// último recurso para los agentes legacy que no emiten telemetría.
fn agent_live_line(state: &AppState, worker: &Worker) -> (String, Color) {
    // 1. Una herramienta corriendo: lo único que de verdad significa "trabajando".
    if let Some(call) = state
        .swarm
        .calls_for(&worker.name)
        .into_iter()
        .min_by_key(|c| c.started_at)
    {
        let mut line = format!("{} {}", call.bee_state.glyph(), call.tool);
        if !call.args_summary.is_empty() {
            let detail = short_arg(&call.args_summary);
            if !detail.is_empty() {
                line.push_str(&format!(" · {detail}"));
            }
        }
        return (line, call.bee_state.color());
    }

    // 2. Una espera explica por qué no avanza. "Corriendo" y "detenido" se veían
    //    igual desde fuera; esta es la diferencia que el usuario vino a ver.
    if let Some(waiting) = state.swarm.waiting.get(&worker.name) {
        return (
            format!("⏳ {}", waiting.reason_label()),
            YELLOW,
        );
    }

    // 3. La última tool que terminó, mientras se decide el siguiente paso.
    if let Some(last) = state.swarm.last_tool.get(&worker.name) {
        if last.settled {
            let mark = if last.ok == Some(false) { "✗" } else { "✓" };
            return (
                format!("{mark} {} · {}", last.tool, last.duration_ms.unwrap_or(0)),
                if last.ok == Some(false) { RED } else { DIM },
            );
        }
    }

    // 4. Legacy: el backend aún no emite telemetría para este agente.
    let fallback = worker
        .current_action
        .as_deref()
        .or(worker.activity.as_deref())
        .or(worker.detail.as_deref())
        .unwrap_or("esperando siguiente acción")
        .to_string();
    (fallback, WHITE)
}

/// Saca el valor legible de un JSON de argumentos: `{"path":"src/a.ts"}` →
/// `src/a.ts`. Una columna de 30 celdas no puede con la llave completa.
fn short_arg(args: &str) -> String {
    let prefer = ["path", "file", "url", "query", "name", "command"];
    for key in prefer {
        let needle = format!("\"{key}\"");
        if let Some(pos) = args.find(&needle) {
            let after = &args[pos + needle.len()..];
            if let Some(colon) = after.find(':') {
                let rest = after[colon + 1..].trim_start();
                let rest = rest.strip_prefix('"').unwrap_or(rest);
                if let Some(end) = rest.find('"') {
                    return rest[..end].to_string();
                }
            }
        }
    }
    args.trim().chars().take(24).collect()
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

        assert!(rows.contains("@TOPO"));
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

#[cfg(test)]
mod swarm_tests {
    use super::*;
    use crate::ipc::BunMessage;
    use crate::state::{BeeState, ToolCall, WaitingAgent, WorkerStatus};

    fn worker(name: &str) -> Worker {
        let mut w = Worker::new(name);
        w.status = WorkerStatus::Running;
        w.detail = Some("detail".to_string());
        w
    }

    fn call(agent: &str, tool: &str, bee_state: BeeState) -> ToolCall {
        ToolCall {
            call_id: format!("{agent}-{tool}"),
            agent: agent.to_string(),
            tool: tool.to_string(),
            args_summary: String::new(),
            bee_state,
            started_at: 10,
            settled: false,
            ok: None,
            duration_ms: None,
        }
    }

    /// El contrato central de esta migración: la telemetría gana siempre.
    #[test]
    fn a_real_tool_call_wins_over_the_legacy_current_action() {
        let mut state = AppState::default();
        let mut w = worker("backend");
        w.current_action = Some("ejecutando implementando endpoint".to_string());
        state.swarm.start_call(call("backend", "fs_write", BeeState::Writing));

        let (line, _) = agent_live_line(&state, &w);
        assert!(line.contains("fs_write"), "no muestra la tool real: {line}");
        assert!(
            !line.contains("ejecutando implementando endpoint"),
            "el texto legacy se cuela: {line}"
        );
    }

    #[test]
    fn a_waiting_agent_says_why_it_is_not_moving() {
        // La distinción que el usuario vino a ver: trabajando vs. detenido.
        let mut state = AppState::default();
        let w = worker("backend");
        state.swarm.set_waiting(WaitingAgent {
            agent: "backend".to_string(),
            waiting_for: vec![],
            reason: "jev_secuencial".to_string(),
            since: 0,
        });

        let (line, _) = agent_live_line(&state, &w);
        assert!(line.contains("en secuencia"), "{line}");
    }

    #[test]
    fn a_waiting_agent_is_not_shown_as_running_a_tool() {
        // Una espera tiene que ganarle a la última tool: si el agente ya no
        // avanza, decir qué tool terminó hace dos segundos confunde.
        let mut state = AppState::default();
        let w = worker("backend");
        state.swarm.start_call(call("backend", "fs_write", BeeState::Writing));
        state.swarm.settle_call("backend-fs_write", true, 40);
        state.swarm.set_waiting(WaitingAgent {
            agent: "backend".to_string(),
            waiting_for: vec![],
            reason: "subagente".to_string(),
            since: 0,
        });

        let (line, _) = agent_live_line(&state, &w);
        assert!(line.contains("esperando subagente"), "{line}");
        assert!(!line.contains("fs_write"), "{line}");
    }

    #[test]
    fn the_last_tool_shows_its_outcome_while_the_next_step_is_decided() {
        let mut state = AppState::default();
        let w = worker("backend");
        state.swarm.start_call(call("backend", "code_test", BeeState::Executing));
        state.swarm.settle_call("backend-code_test", true, 1840);

        let (line, _) = agent_live_line(&state, &w);
        assert!(line.contains("code_test"), "{line}");
        assert!(line.contains("1840"), "no muestra la duración: {line}");
    }

    #[test]
    fn a_failed_tool_is_marked_as_failed() {
        let mut state = AppState::default();
        let w = worker("backend");
        state.swarm.start_call(call("backend", "shell_executor", BeeState::Executing));
        state.swarm.settle_call("backend-shell_executor", false, 90);

        let (line, color) = agent_live_line(&state, &w);
        assert!(line.starts_with('✗'), "{line}");
        assert_eq!(color, RED);
    }

    #[test]
    fn a_legacy_agent_without_telemetry_still_shows_something() {
        // El swarm puede no haber enviado nada todavía: un panel en blanco
        // parecería un bug.
        let state = AppState::default();
        let mut w = worker("backend");
        w.current_action = Some("implementando endpoint".to_string());

        let (line, _) = agent_live_line(&state, &w);
        assert_eq!(line, "implementando endpoint");
    }

    #[test]
    fn a_legacy_agent_with_nothing_falls_back_to_an_explicit_placeholder() {
        // Un worker sin `detail` tampoco: entonces sí, el placeholder. Un panel
        // en blanco parecería un bug.
        let state = AppState::default();
        let mut w = Worker::new("backend");
        w.detail = None;
        let (line, _) = agent_live_line(&state, &w);
        assert_eq!(line, "esperando siguiente acción");
    }

    #[test]
    fn args_are_summarised_by_their_most_useful_key() {
        assert_eq!(short_arg(r#"{"path":"src/auth/token.ts"}"#), "src/auth/token.ts");
        assert_eq!(short_arg(r#"{"command":"bun test"}"#), "bun test");
        assert_eq!(short_arg(r#"{"file":"a.rs"}"#), "a.rs");
        // Sin clave reconocible, se recortan los primeros caracteres.
        let raw = r#"{"weirdkey":"some long value here"}"#;
        assert!(short_arg(raw).chars().count() <= 24);
    }

    #[test]
    fn malformed_args_never_panic() {
        for raw in ["", "{", "{\"path\":", "\"sin objeto\"", "[]"] {
            let _ = short_arg(raw);
        }
    }

    #[test]
    fn the_pulse_prioritises_being_stuck_over_being_busy() {
        let mut state = AppState::default();
        state.swarm.start_call(call("a", "fs_read", BeeState::Reading));
        state.swarm.set_waiting(WaitingAgent {
            agent: "b".to_string(),
            waiting_for: vec![],
            reason: "dependencia".to_string(),
            since: 0,
        });

        let (text, _) = swarm_pulse(&state).expect("hay algo que decir");
        assert!(text.contains("en espera"), "{text}");
        // Ambas cifras conviven: "1 trabajando y 1 parado" es información distinta
        // de "nada funciona".
        assert!(text.contains('1'), "{text}");
    }

    #[test]
    fn the_pulse_says_nothing_when_the_swarm_is_quiet() {
        // Celdas ocupadas sin información son ruido.
        assert!(swarm_pulse(&AppState::default()).is_none());
    }

    #[test]
    fn a_wait_chip_renders_on_the_card() {
        let mut state = AppState::default();
        state.workers.workers.push(worker("backend"));
        state.swarm.set_waiting(WaitingAgent {
            agent: "backend".to_string(),
            waiting_for: vec![],
            reason: "jev_secuencial".to_string(),
            since: 0,
        });

        let mut canvas = Canvas::new(100, 30);
        render(&mut canvas, Rect::new(0, 0, 100, 30), &state);
        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("en secuencia"), "{frame}");
    }

    #[test]
    fn a_tool_call_reaches_the_card_through_the_real_reducer() {
        // El camino completo: mensaje IPC → estado → pantalla.
        let mut state = AppState::default();
        state.workers.workers.push(worker("backend"));
        state.apply_message(BunMessage::ToolCall {
            agent: "backend".to_string(),
            tool: "fs_write".to_string(),
            call_id: "c1".to_string(),
            args_summary: r#"{"path":"src/a.ts"}"#.to_string(),
            bee_state: "writing".to_string(),
            task_id: None,
            at: 100,
        });

        assert_eq!(state.swarm.orphaned_calls(), 1);
        let mut canvas = Canvas::new(100, 30);
        render(&mut canvas, Rect::new(0, 0, 100, 30), &state);
        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("fs_write"), "{frame}");
        assert!(frame.contains("src/a.ts"), "{frame}");
    }

    #[test]
    fn a_running_worker_with_a_failed_tool_is_visible_as_failed() {
        let mut state = AppState::default();
        state.workers.workers.push(worker("backend"));
        state.apply_message(BunMessage::ToolCall {
            agent: "backend".to_string(),
            tool: "code_build".to_string(),
            call_id: "c1".to_string(),
            args_summary: String::new(),
            bee_state: "executing".to_string(),
            task_id: None,
            at: 1,
        });
        state.apply_message(BunMessage::ToolDone {
            agent: "backend".to_string(),
            tool: "code_build".to_string(),
            call_id: "c1".to_string(),
            ok: false,
            duration_ms: 320,
            result_summary: String::new(),
            task_id: None,
            at: 321,
        });

        let (line, color) = agent_live_line(&state, &state.workers.workers[0]);
        assert!(line.contains("code_build"), "{line}");
        assert_eq!(color, RED);
    }

    #[test]
    fn the_worker_status_still_drives_the_border_not_the_telemetry() {
        // El borde refleja el estado del worker legacy; la línea interior
        // reflecta la telemetría. Son dos señales y no deben pisarse.
        let mut state = AppState::default();
        let mut failed = Worker::new("backend");
        failed.status = WorkerStatus::Failed;
        state.workers.workers.push(failed);
        state.swarm.start_call(call("backend", "fs_read", BeeState::Reading));

        let mut canvas = Canvas::new(100, 30);
        render(&mut canvas, Rect::new(0, 0, 100, 30), &state);
        let frame = canvas.to_text_rows().join("\n");
        assert!(frame.contains("fs_read"), "{frame}");
    }
}
