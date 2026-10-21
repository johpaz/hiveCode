//! Colmena viva: stable instance cells, real relationships and a task-scoped inspector.
use super::dashboard_layout::short_arg;
use crate::ui::fmt_tokens;
use crate::{
    state::{AppState, ModalState, StreamEntry, Worker, WorkerStatus},
    term::{
        Canvas, Color, Rect, Style, AMBER_BRIGHT, BG_ELEVATED, CYAN, DIM, GREEN, RED, SECONDARY,
        WHITE, YELLOW,
    },
    ui::{ellipsize_cells, wrap_cells, HitAction, MouseRegion, Overflow},
};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone)]
pub(crate) struct OfficeAgent {
    pub worker: Worker,
    pub(crate) telemetry: String,
    blocked: Vec<String>,
}

fn base(id: &str) -> String {
    super::office_art::profile_key(id.split('#').next().unwrap_or(id))
}

/// Only legacy profile aliases are merged; numbered and ephemeral instances keep their exact IDs.
fn identity(id: &str) -> String {
    if id.contains('#') {
        id.to_string()
    } else {
        base(id)
    }
}

pub(crate) fn agents(state: &AppState) -> Vec<OfficeAgent> {
    let mut result = BTreeMap::new();
    for roster in state.roster.by_id.values() {
        if roster.id.contains('#') {
            continue;
        }
        let mut worker = Worker::new(&roster.id);
        worker.display_name = roster.alias.clone();
        worker.detail = Some(roster.funcion.clone());
        result.insert(
            identity(&roster.id),
            OfficeAgent {
                worker,
                telemetry: roster.id.clone(),
                blocked: roster
                    .blocked_by()
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            },
        );
    }
    let workers: Vec<&Worker> = if state.colony.task_id.is_some() {
        state.colony.workers.values().collect()
    } else {
        state.workers.workers.iter().collect()
    };
    let replaced = |worker: &Worker| {
        workers
            .iter()
            .any(|w| w.replaces_worker.as_deref() == Some(worker.name.as_str()))
    };
    for worker in &workers {
        if replaced(worker) {
            continue;
        }
        // Older task activity must not bleed into the current scene.
        if state.colony.task_id.is_some() && !state.colony.members.contains(&worker.name) {
            continue;
        }
        let key = identity(&worker.name);
        if result
            .get(&key)
            .is_some_and(|a: &OfficeAgent| a.worker.status == WorkerStatus::Running)
            && worker.status == WorkerStatus::Waiting
        {
            continue;
        }
        let roster = state
            .roster
            .by_id
            .get(&worker.name)
            .or_else(|| state.roster.by_id.values().find(|r| identity(&r.id) == key));
        let mut live = (*worker).clone();
        if let Some(r) = roster {
            live.display_name = r.alias.clone();
        }
        result.insert(
            key,
            OfficeAgent {
                worker: live,
                telemetry: worker.name.clone(),
                blocked: roster
                    .map(|r| r.blocked_by().into_iter().map(str::to_string).collect())
                    .unwrap_or_default(),
            },
        );
    }
    // Delegations can precede worker_update (and temporary agents need no roster seat).
    for id in &state.colony.members {
        let a = result.entry(identity(id)).or_insert_with(|| OfficeAgent {
            worker: Worker::new(id),
            telemetry: id.clone(),
            blocked: vec![],
        });
        a.telemetry = id.clone();
        a.worker.name = id.clone();
    }
    let mut cast: Vec<_> = result.into_values().collect();
    cast.retain(|a| {
        !replaced(&a.worker)
            && !workers
                .iter()
                .any(|w| w.replaces_worker.as_deref() == Some(&a.telemetry))
    });
    cast.sort_by_key(|a| {
        let role = base(&a.worker.name);
        let order = ["bee", "planner", "scout", "builder", "verifier", "spider"];
        (
            order.iter().position(|r| *r == role).unwrap_or(order.len()),
            a.worker.name.clone(),
        )
    });
    cast
}

fn state_label(state: &AppState, agent: &OfficeAgent) -> (String, Color) {
    let id = &agent.telemetry;
    let status =
        state
            .colony
            .statuses
            .get(id)
            .map(String::as_str)
            .unwrap_or(match agent.worker.status {
                WorkerStatus::Done => "done",
                WorkerStatus::Failed => "failed",
                WorkerStatus::Running => "running",
                WorkerStatus::Warn => "warn",
                _ => "idle",
            });
    if matches!(status, "failed" | "cancelled") {
        return ("✗ fallido".into(), RED);
    }
    if matches!(status, "done" | "completed") {
        return ("✓ terminado".into(), GREEN);
    }
    if let ModalState::ToolApproval(approval) = &state.modal {
        if approval.agent == *id {
            return ("? pendiente de aprobación".into(), YELLOW);
        }
    }
    if let Some(wait) = state.colony.telemetry.waiting.get(id) {
        return (
            format!(
                "… {} · {}",
                wait.reason_label(),
                wait.waiting_for.join(", ")
            ),
            YELLOW,
        );
    }
    if !agent.blocked.is_empty() {
        return (
            format!("! MCP apagado: {}", agent.blocked.join(", ")),
            YELLOW,
        );
    }
    let mut calls = state.colony.telemetry.calls_for(id);
    calls.sort_by_key(|c| (c.started_at, &c.call_id));
    if let Some(call) = calls.first() {
        let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
        return (
            format!(
                "{} {} · {} · {}s{}",
                call.bee_state.glyph(),
                call.bee_state.label(),
                call.tool,
                now.saturating_sub(call.started_at) / 1000,
                if calls.len() > 1 {
                    format!(" (+{})", calls.len() - 1)
                } else {
                    String::new()
                }
            ),
            call.bee_state.color(),
        );
    }
    if let Some(activity) = state.colony.activity.get(id) {
        return (format!("◐ {activity}"), CYAN);
    }
    match status {
        "running" | "thinking" | "active" => ("◌ trabajando".into(), WHITE),
        "waiting" | "blocked" => ("… esperando".into(), YELLOW),
        "warn" => ("! atención".into(), YELLOW),
        _ => ("○ disponible".into(), DIM),
    }
}

fn task<'a>(state: &'a AppState, a: &'a OfficeAgent) -> &'a str {
    state
        .colony
        .tasks
        .get(&a.telemetry)
        .map(String::as_str)
        .or(a.worker.current_action.as_deref())
        .or(a.worker.current_file.as_deref())
        .or(a.worker.detail.as_deref())
        .unwrap_or("sin tarea asignada")
}

pub(crate) fn code_worker(state: &AppState, id: &str) -> String {
    state
        .workers
        .workers
        .iter()
        .find(|w| w.name == id)
        .or_else(|| {
            state
                .workers
                .workers
                .iter()
                .find(|w| identity(&w.name) == identity(id))
        })
        .map(|w| w.name.clone())
        .unwrap_or_else(|| id.to_string())
}

struct Layout {
    floor: Rect,
    inspector: Rect,
    compact: bool,
}
fn layout(area: Rect, state: &AppState) -> Layout {
    let selected = state.dashboard.office.selected.is_some();
    let side = selected && area.w >= 120 && area.h >= 18;
    let floor = if side {
        Rect::new(area.x, area.y, area.w * 2 / 3 - 1, area.h)
    } else {
        area
    };
    let inspector = if side {
        Rect::new(
            floor.right() + 1,
            area.y,
            area.right() - floor.right() - 1,
            area.h,
        )
    } else if selected {
        area
    } else {
        Rect::default()
    };
    Layout {
        floor,
        inspector,
        compact: floor.w < 80 || floor.h < 15,
    }
}

fn seats(area: Rect, state: &AppState, cast: &[OfficeAgent], compact: bool) -> Vec<(usize, Rect)> {
    if area.w < 2 || area.h < 3 || cast.is_empty() {
        return vec![];
    }
    let bee = cast
        .iter()
        .position(|a| base(&a.worker.name) == "bee")
        .unwrap_or(0);
    let others: Vec<_> = (0..cast.len()).filter(|i| *i != bee).collect();
    let mut placements = Vec::new();
    if compact {
        let capacity = (area.h.saturating_sub(2) / 2) as usize;
        let start = state
            .dashboard_scroll
            .min(others.len().saturating_sub(capacity.saturating_sub(1)));
        for (slot, index) in std::iter::once(bee)
            .chain(others.into_iter().skip(start))
            .take(capacity)
            .enumerate()
        {
            placements.push((
                index,
                Rect::new(area.x, area.y + 1 + slot as u16 * 2, area.w, 2),
            ));
        }
    } else {
        // A six-cell crown around a fixed nucleus, rather than rows of cards.
        let node_h = if area.h >= 23 { 7 } else { 5 };
        let body = Rect::new(area.x + 1, area.y + 1, area.w - 2, area.h - 2);
        let node_w = ((body.w - 6) / 3).min(40);
        let core_h = if body.h >= node_h * 3 + 2 {
            node_h + 2
        } else {
            node_h
        };
        let core_w = (node_w + 4).min(body.w);
        let center = Rect::new(
            body.x + (body.w - core_w) / 2,
            body.y + (body.h - core_h) / 2,
            core_w,
            core_h,
        );
        placements.push((bee, center));
        let left = body.x;
        let right = body.right() - node_w;
        let middle = body.x + (body.w - node_w) / 2;
        let travel = body.h - node_h;
        let lower = if others.len() <= 5 {
            travel
        } else {
            travel * 3 / 4
        };
        let slots = [
            (middle, body.y),
            (left, body.y + travel / 4),
            (right, body.y + travel / 4),
            (left, body.y + lower),
            (right, body.y + lower),
            (middle, body.y + travel),
        ];
        let start = state.dashboard_scroll.min(others.len().saturating_sub(6));
        for (index, (x, y)) in others.into_iter().skip(start).zip(slots) {
            placements.push((index, Rect::new(x, y, node_w, node_h)));
        }
    }
    placements
}

pub fn select_next(state: &mut AppState, direction: i32) {
    let cast = agents(state);
    if cast.is_empty() {
        return;
    }
    let current = cast
        .iter()
        .position(|a| state.dashboard.office.selected.as_ref() == Some(&a.worker.name));
    let index = current
        .map(|i| (i as i32 + direction).rem_euclid(cast.len() as i32) as usize)
        .unwrap_or(if direction < 0 { cast.len() - 1 } else { 0 });
    select(state, cast[index].worker.name.clone());
}

pub fn select(state: &mut AppState, id: String) {
    state.dashboard.office.selected = Some(id.clone());
    state.dashboard.office.inspector_offset = 0;
    state.dashboard.office.paused = false;
    let cast = agents(state);
    let (w, h) = state.dashboard.office.viewport;
    let area = Rect::new(0, 0, w.max(40), h.max(4));
    let l = layout(area, state);
    if !seats(l.floor, state, &cast, l.compact)
        .iter()
        .any(|(i, _)| cast[*i].worker.name == id)
    {
        state.dashboard_scroll = cast
            .iter()
            .filter(|a| base(&a.worker.name) != "bee")
            .position(|a| a.worker.name == id)
            .unwrap_or(0);
    }
}

pub fn worker_at(state: &AppState, area: Rect, x: u16, y: u16) -> Option<String> {
    let l = layout(area, state);
    if l.inspector == area && state.dashboard.office.selected.is_some() {
        return None;
    }
    let cast = agents(state);
    seats(l.floor, state, &cast, l.compact)
        .iter()
        .find(|(_, r)| r.contains(x, y))
        .map(|(i, _)| cast[*i].worker.name.clone())
}

pub fn register_hits(state: &mut AppState, area: Rect) {
    state.dashboard.office.viewport = (area.w, area.h);
    let l = layout(area, state);
    let cast = agents(state);
    if l.inspector != area || state.dashboard.office.selected.is_none() {
        for (i, r) in seats(l.floor, state, &cast, l.compact) {
            let id = format!("office:select:{}", cast[i].worker.name);
            state
                .hit_map
                .push(MouseRegion::new(&id, r, 1, HitAction::Custom(id.clone())));
        }
    }
    if l.inspector.h > 0 {
        for (id, x, w) in [
            ("colony:expand", l.inspector.x, l.inspector.w / 2),
            (
                "colony:live",
                l.inspector.x + l.inspector.w / 2,
                l.inspector.w - l.inspector.w / 2,
            ),
        ] {
            state.hit_map.push(MouseRegion::new(
                id,
                Rect::new(x, l.inspector.bottom() - 1, w, 1),
                3,
                HitAction::Custom(id.into()),
            ));
        }
    }
}

fn text(canvas: &mut Canvas, area: Rect, row: u16, value: &str, color: Color) {
    if row < area.h {
        canvas.print(
            area.x,
            area.y + row,
            &ellipsize_cells(value, area.w as usize),
            Style::new().fg(color),
        );
    }
}

struct Edge {
    from: String,
    to: String,
    label: &'static str,
    pulse: bool,
}
fn edges(state: &AppState, cast: &[OfficeAgent]) -> Vec<Edge> {
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    // Only most recent state of each delegation is drawn.
    for e in state.colony.relations.iter().rev() {
        if !seen.insert(e.id.clone()) {
            continue;
        }
        let (from, to, label) = match e.kind.as_str() {
            "handoff" => (e.to.clone(), e.from.clone(), "entrega"),
            "failed" => (e.to.clone(), e.from.clone(), "fallo"),
            _ => (e.from.clone(), e.to.clone(), "delega"),
        };
        edges.push(Edge {
            from,
            to,
            label,
            pulse: e.received_at.elapsed().as_millis() < 1800,
        });
    }
    for (to, parent) in &state.colony.parents {
        if !edges
            .iter()
            .any(|e| (&e.from == parent && &e.to == to) || (&e.to == parent && &e.from == to))
        {
            edges.push(Edge {
                from: parent.clone(),
                to: to.clone(),
                label: "delega",
                pulse: false,
            });
        }
    }
    let resolve = |id: &str| -> Option<String> {
        let candidates: Vec<_> = cast
            .iter()
            .filter(|a| {
                if id.contains('#') {
                    a.telemetry == id
                } else {
                    base(&a.telemetry) == base(id)
                }
            })
            .collect();
        if candidates.len() == 1 {
            Some(candidates[0].telemetry.clone())
        } else {
            None
        }
    };
    if let Some(plan) = &state.plan.current {
        if state
            .colony
            .task_id
            .as_ref()
            .is_none_or(|id| id == &plan.task_id)
        {
            for phase in &plan.phases {
                for dep in &phase.depends_on {
                    if let Some(prerequisite) = plan.phases.iter().find(|p| &p.name == dep) {
                        if let (Some(from), Some(to)) = (
                            resolve(&prerequisite.coordinator),
                            resolve(&phase.coordinator),
                        ) {
                            if from != to {
                                edges.push(Edge {
                                    from,
                                    to,
                                    label: "depende",
                                    pulse: false,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    for wait in state.colony.telemetry.waiting.values() {
        for target in &wait.waiting_for {
            // A task ref must never be mistaken for an agent ID.
            if let Some(from) = cast.iter().find(|a| &a.telemetry == target) {
                edges.push(Edge {
                    from: from.telemetry.clone(),
                    to: wait.agent.clone(),
                    label: "espera",
                    pulse: false,
                });
            }
        }
    }
    edges
}

const SCENE_BG: Color = Color::Rgb {
    r: 14,
    g: 20,
    b: 23,
};
const CELL_BG: Color = Color::Rgb {
    r: 22,
    g: 31,
    b: 34,
};
const HONEY_BG: Color = Color::Rgb {
    r: 43,
    g: 34,
    b: 19,
};
const WAX: Color = Color::Rgb {
    r: 107,
    g: 86,
    b: 43,
};
const GRID: Color = Color::Rgb {
    r: 30,
    g: 43,
    b: 46,
};

fn inset(row: u16, height: u16) -> u16 {
    let edge = row.min(height - 1 - row);
    match edge {
        0 => 4,
        1 => 2,
        2 => 1,
        _ => 0,
    }
}

fn centered(canvas: &mut Canvas, area: Rect, row: u16, value: &str, color: Color) {
    if row >= area.h {
        return;
    }
    let value = ellipsize_cells(value, area.w as usize);
    let width = unicode_width::UnicodeWidthStr::width(value.as_str()) as u16;
    canvas.print(
        area.x + (area.w - width) / 2,
        area.y + row,
        &value,
        Style::new().fg(color),
    );
}

fn draw_hex(canvas: &mut Canvas, area: Rect, color: Color, bg: Color, bold: bool) {
    let style = Style::new().fg(color).bg(bg);
    let style = if bold { style.bold() } else { style };
    for row in 0..area.h {
        let n = inset(row, area.h).min(area.w / 2);
        let width = area.w.saturating_sub(n * 2);
        canvas.fill_rect(
            Rect::new(area.x + n, area.y + row, width, 1),
            ' ',
            Style::new().bg(bg),
        );
        if row == 0 || row == area.h - 1 {
            for col in 0..width {
                canvas.print(area.x + n + col, area.y + row, "─", style);
            }
        } else {
            let (left, right) = if row < area.h / 2 {
                ("╱", "╲")
            } else if row > area.h / 2 {
                ("╲", "╱")
            } else {
                ("│", "│")
            };
            canvas.print(area.x + n, area.y + row, left, style);
            canvas.print(area.right() - n - 1, area.y + row, right, style);
        }
    }
}

fn route(a: (u16, u16), b: (u16, u16)) -> Vec<(u16, u16)> {
    let steps = a.0.abs_diff(b.0).max(a.1.abs_diff(b.1)).max(1) as i32;
    (0..=steps)
        .map(|n| {
            (
                (a.0 as i32 + (b.0 as i32 - a.0 as i32) * n / steps) as u16,
                (a.1 as i32 + (b.1 as i32 - a.1 as i32) * n / steps) as u16,
            )
        })
        .collect()
}

fn draw_edges(
    canvas: &mut Canvas,
    state: &AppState,
    cast: &[OfficeAgent],
    placements: &[(usize, Rect)],
    foreground: bool,
) {
    let rect = |id: &str| {
        placements
            .iter()
            .find(|(i, _)| cast[*i].telemetry == id)
            .map(|(_, r)| *r)
    };
    for edge in edges(state, cast) {
        let selected = state.dashboard.office.selected.as_deref();
        let emphasized = selected.is_some_and(|id| id == edge.from || id == edge.to);
        let color = if edge.label == "fallo" {
            RED
        } else if edge.label == "entrega" {
            GREEN
        } else if emphasized || edge.pulse {
            AMBER_BRIGHT
        } else {
            WAX
        };
        if let (Some(a), Some(b)) = (rect(&edge.from), rect(&edge.to)) {
            let points = route(
                (a.x + a.w / 2, a.y + a.h / 2),
                (b.x + b.w / 2, b.y + b.h / 2),
            );
            if foreground {
                // Event badges belong on the wax rim, leaving agent content intact.
                if edge.pulse || emphasized {
                    let label = format!(
                        " {} {} ",
                        if edge.label == "entrega" {
                            "←"
                        } else {
                            "→"
                        },
                        edge.label
                    );
                    centered(canvas, b, b.h - 1, &label, color);
                }
            } else {
                for (n, (x, y)) in points.iter().enumerate() {
                    let glyph = if edge.pulse && n == state.anim_tick as usize * points.len() / 8 {
                        "◆"
                    } else if n % 3 == 0 {
                        "·"
                    } else {
                        "─"
                    };
                    canvas.print(*x, *y, glyph, Style::new().fg(color));
                }
            }
        }
    }
}

fn draw_agent(canvas: &mut Canvas, state: &AppState, agent: &OfficeAgent, area: Rect) {
    let selected = state.dashboard.office.selected.as_ref() == Some(&agent.worker.name);
    let bee = base(&agent.worker.name) == "bee";
    let (activity, color) = state_label(state, agent);
    let color = if activity.contains("disponible") {
        SECONDARY
    } else {
        color
    };
    let calls = state.colony.telemetry.calls_for(&agent.telemetry);
    let stopped = activity.starts_with('✓')
        || activity.starts_with('✗')
        || activity.contains("aprobación")
        || activity.contains("MCP apagado")
        || state
            .colony
            .telemetry
            .waiting
            .contains_key(&agent.telemetry);
    let active = !stopped
        && (!calls.is_empty()
            || state.colony.activity.contains_key(&agent.telemetry)
            || state
                .colony
                .statuses
                .get(&agent.telemetry)
                .is_some_and(|s| s == "running")
            || agent.worker.status == WorkerStatus::Running);
    let edge = if selected {
        CYAN
    } else if bee {
        AMBER_BRIGHT
    } else if active {
        color
    } else {
        WAX
    };
    let bg = if bee { HONEY_BG } else { CELL_BG };
    canvas.with_clip(area, |canvas| {
        draw_hex(canvas, area, edge, bg, bee || selected);
        let tall = area.h >= 7;
        let title_row = if tall { 1 } else { 0 };
        let title = if bee {
            "@BEE · NÚCLEO".to_string()
        } else {
            format!("@{}", agent.worker.name.to_uppercase())
        };
        centered(
            canvas,
            Rect::new(area.x + 4, area.y, area.w - 8, area.h),
            title_row,
            &title,
            if bee || selected { AMBER_BRIGHT } else { WHITE },
        );
        let sprite_y = area.y + if tall { 2 } else { 1 };
        super::office_art::draw(
            canvas,
            area.x + 3,
            sprite_y,
            &base(&agent.worker.name),
            state.anim_tick,
            active,
            false,
        );
        let detail = Rect::new(area.x + 15, sprite_y, area.w.saturating_sub(18), 3);
        text(
            canvas,
            detail,
            0,
            &format!("@{}", agent.worker.display_name.to_uppercase()),
            if bee { AMBER_BRIGHT } else { SECONDARY },
        );
        let status = if activity.contains("disponible") {
            "disponible"
        } else if activity.contains("fallido") {
            "✗ fallido"
        } else if activity.contains("terminado") {
            "✓ terminado"
        } else if activity.contains("aprobación") {
            "? aprobación"
        } else if activity.contains("MCP apagado") {
            "! MCP apagado"
        } else if state
            .colony
            .telemetry
            .waiting
            .contains_key(&agent.telemetry)
        {
            "… en espera"
        } else if bee
            && calls.iter().any(|c| {
                matches!(
                    c.tool.as_str(),
                    "task_delegate" | "task_revise" | "spawn_agent"
                )
            })
        {
            "→ coordinando"
        } else if let Some(call) = calls.iter().min_by_key(|c| c.started_at) {
            call.bee_state.label()
        } else if state
            .colony
            .activity
            .get(&agent.telemetry)
            .is_some_and(|s| s == "narrando")
        {
            "▸ narrando"
        } else if state
            .colony
            .activity
            .get(&agent.telemetry)
            .is_some_and(|s| s == "razonando")
        {
            "◐ razonando"
        } else if active {
            "◌ trabajando"
        } else {
            "○ en reposo"
        };
        text(canvas, detail, 1, status, color);
        if let Some(call) = calls.iter().min_by_key(|c| c.started_at) {
            let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
            text(
                canvas,
                detail,
                2,
                &if !tall {
                    call.tool.clone()
                } else {
                    format!(
                        "{}s{}",
                        now.saturating_sub(call.started_at) / 1000,
                        if calls.len() > 1 {
                            format!(" (+{})", calls.len() - 1)
                        } else {
                            String::new()
                        }
                    )
                },
                color,
            );
        } else {
            text(
                canvas,
                detail,
                2,
                if bee { "orquestador" } else { "especialista" },
                DIM,
            );
        }
        let caption = if let Some(wait) = state.colony.telemetry.waiting.get(&agent.telemetry) {
            wait.reason_label().to_string()
        } else if let Some(call) = calls.iter().min_by_key(|c| c.started_at) {
            format!("{} · {}", call.tool, short_arg(&call.args_summary))
        } else if activity.contains("MCP apagado") {
            activity.clone()
        } else if state
            .colony
            .activity
            .get(&agent.telemetry)
            .is_some_and(|a| a == "narrando")
        {
            state
                .colony
                .entries
                .iter()
                .rev()
                .find_map(|e| match e {
                    StreamEntry::Narracion {
                        agent: a, texto, ..
                    } if a == &agent.telemetry => Some(format!("▸ {texto}")),
                    _ => None,
                })
                .unwrap_or_else(|| activity.clone())
        } else if active {
            activity.clone()
        } else if bee {
            "ESPERANDO TU TAREA".into()
        } else {
            String::new()
        };
        let caption_row = if tall { area.h - 2 } else { area.h - 1 };
        if tall {
            centered(
                canvas,
                Rect::new(area.x + 4, area.y, area.w - 8, area.h),
                caption_row,
                &caption,
                color,
            );
        }
        if selected {
            canvas.print(
                area.x + area.w / 2,
                area.y + area.h - 1,
                "▼",
                Style::new().fg(CYAN).bg(bg),
            );
        }
    });
}

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.w < 2 || area.h == 0 {
        return;
    }
    let cast = agents(state);
    let l = layout(area, state);
    let placements = seats(l.floor, state, &cast, l.compact);
    canvas.with_clip(area,|canvas| {
        canvas.fill_rect(area,' ',Style::new().bg(SCENE_BG));
        if l.inspector!=area || state.dashboard.office.selected.is_none() {
            if !l.compact {
                for y in l.floor.y+1..l.floor.bottom().saturating_sub(1) {
                    for x in l.floor.x+1..l.floor.right().saturating_sub(1) {
                        if (x-l.floor.x)%12==((y-l.floor.y)%4)*3 {canvas.print(x,y,"·",Style::new().fg(GRID));}
                    }
                }
                draw_edges(canvas,state,&cast,&placements,false);
            }
            text(canvas,l.floor,0,"⬡ COLMENA VIVA · Alt+↑/↓ lupa · Enter Código",AMBER_BRIGHT);
            for (i,r) in &placements {
                let a=&cast[*i];
                if l.compact {
                    let (activity,color)=state_label(state,a);
                    let name=format!("@{} · @{}",a.worker.name.to_uppercase(),a.worker.display_name.to_uppercase());
                    text(canvas,*r,0,&name,WHITE);
                    text(canvas,*r,1,&activity,color);
                } else {draw_agent(canvas,state,a,*r);}
            }
            if !l.compact {draw_edges(canvas,state,&cast,&placements,true);}
            if area.h>2 {
                let active=cast.iter().filter(|a|state.colony.telemetry.calls_for(&a.telemetry).len()>0 || state.colony.activity.contains_key(&a.telemetry)).count();
                let summary=if active==0 {format!("{}/{} instancias · en reposo · PgUp/PgDn · envía una tarea para activar el flujo",placements.len(),cast.len())}
                    else {format!("{}/{} instancias · {active} trabajando · rueda/PgUp/PgDn · clic para explorar",placements.len(),cast.len())};
                text(canvas,l.floor,l.floor.h-1,&summary,SECONDARY);
            }
        }
        if let Some(a)=cast.iter().find(|a|state.dashboard.office.selected.as_ref()==Some(&a.worker.name)) {inspector(canvas,l.inspector,state,a);}
    });
}

fn inspector_lines(state: &AppState, a: &OfficeAgent, width: usize) -> Vec<(String, Color)> {
    let mut lines = vec![];
    let expanded = state.dashboard.office.expanded;
    let mut add = |label: &str, value: &str, color: Color, full: bool| {
        let value = format!("{label}{value}");
        if full {
            for line in wrap_cells(&value, width, Overflow::Wrap) {
                lines.push((line, color));
            }
        } else {
            lines.push((ellipsize_cells(&value, width), color));
        }
    };
    add("Instancia: ", &a.telemetry, WHITE, true);
    if expanded {
        add("Tarea: ", task(state, a), WHITE, true);
    }
    add(
        "Métricas: ",
        &format!(
            "iter {}/{} · {} tok",
            a.worker.iteration_current.unwrap_or(0),
            a.worker.iteration_total.unwrap_or(0),
            fmt_tokens(a.worker.token_count)
        ),
        SECONDARY,
        true,
    );
    if let Some(parent) = state.colony.parents.get(&a.telemetry) {
        add("Responsable: ", parent, SECONDARY, true);
    }
    if let Some(wait) = state.colony.telemetry.waiting.get(&a.telemetry) {
        add(
            "Espera: ",
            &format!("{} · {}", wait.reason_label(), wait.waiting_for.join(", ")),
            YELLOW,
            true,
        );
    }
    for edge in edges(state, &agents(state))
        .into_iter()
        .filter(|e| e.from == a.telemetry || e.to == a.telemetry)
    {
        add(
            "↔ ",
            &format!("{} → {} · {}", edge.from, edge.to, edge.label),
            SECONDARY,
            true,
        );
    }
    let mut calls = state.colony.telemetry.calls_for(&a.telemetry);
    calls.sort_by_key(|c| (c.started_at, &c.call_id));
    for call in calls {
        let elapsed = (chrono::Utc::now().timestamp_millis().max(0) as u64)
            .saturating_sub(call.started_at)
            / 1000;
        add(
            "⚙ Activa: ",
            &format!(
                "{} · {elapsed}s · {}",
                call.tool,
                short_arg(&call.args_summary)
            ),
            CYAN,
            true,
        );
    }
    add("", "CRONOLOGÍA", AMBER_BRIGHT, false);
    let mut reasoning = false;
    for entry in state
        .colony
        .entries
        .iter()
        .filter(|e| e.agent() == a.telemetry)
    {
        let (label, color, full) = match entry {
            StreamEntry::Razonamiento { .. } => {
                reasoning = true;
                (
                    if expanded {
                        "◐ Razonamiento: "
                    } else {
                        "◐ Razonamiento · Alt+e para expandir"
                    },
                    DIM,
                    expanded,
                )
            }
            StreamEntry::Narracion { .. } => ("▸ Narración: ", WHITE, true),
            StreamEntry::ToolStart { .. } => ("⚙ Herramienta: ", CYAN, expanded),
            StreamEntry::ToolDone { ok: true, .. } => ("✓ Resultado: ", GREEN, expanded),
            StreamEntry::ToolDone { ok: false, .. } | StreamEntry::Error { .. } => {
                ("✗ Error: ", RED, true)
            }
            StreamEntry::Bloqueado { .. } => ("… Espera: ", YELLOW, true),
            StreamEntry::Pregunta { .. } => ("? Pregunta: ", YELLOW, true),
        };
        let content = if entry.is_verbose() && !expanded {
            String::new()
        } else {
            entry.summary()
        };
        add(label, &content, color, full);
    }
    if !reasoning {
        add("", "Razonamiento: sin contenido disponible", DIM, true);
    }
    add("", "COLABORACIÓN", AMBER_BRIGHT, false);
    for e in state
        .colony
        .relations
        .iter()
        .filter(|e| e.to == a.telemetry || e.from == a.telemetry)
    {
        let label = match e.kind.as_str() {
            "handoff" => "✓ Entrega: ",
            "failed" => "✗ Entrega fallida: ",
            _ => "→ Delegación: ",
        };
        add(
            label,
            &format!("{} → {} · {}", e.from, e.to, e.summary),
            SECONDARY,
            expanded,
        );
    }
    lines
}

fn inspector(canvas: &mut Canvas, area: Rect, state: &AppState, a: &OfficeAgent) {
    if area.w < 2 || area.h == 0 {
        return;
    }
    canvas.with_clip(area, |canvas| {
        canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
        let content = Rect::new(area.x + 1, area.y, area.w.saturating_sub(2), area.h);
        let (activity, color) = state_label(state, a);
        text(
            canvas,
            content,
            0,
            &format!("LUPA · @{} ({})", a.worker.display_name, a.worker.name),
            AMBER_BRIGHT,
        );
        text(
            canvas,
            content,
            1,
            &format!("Tarea: {}", task(state, a)),
            WHITE,
        );
        text(canvas, content, 2, &activity, color);
        if let Some(path) = &a.worker.current_file {
            text(canvas, content, 3, path, SECONDARY);
        }
        let lines = inspector_lines(state, a, content.w as usize);
        let visible = content.h.saturating_sub(5) as usize;
        let end = lines.len().saturating_sub(visible);
        let start = if state.dashboard.office.paused {
            state.dashboard.office.inspector_offset.min(end)
        } else {
            end
        };
        for (row, (value, color)) in lines.iter().skip(start).take(visible).enumerate() {
            text(canvas, content, row as u16 + 4, value, *color);
        }
        if content.h > 0 {
            text(
                canvas,
                content,
                content.h - 1,
                &format!(
                    "Alt+e {} · Alt+End {} · Esc",
                    if state.dashboard.office.expanded {
                        "contraer"
                    } else {
                        "expandir"
                    },
                    if state.dashboard.office.paused {
                        "volver al directo"
                    } else {
                        "EN VIVO"
                    }
                ),
                AMBER_BRIGHT,
            );
        }
    });
}

pub fn scroll(state: &mut AppState, delta: i32) {
    if let Some(a) = agents(state)
        .iter()
        .find(|a| state.dashboard.office.selected.as_ref() == Some(&a.worker.name))
        .cloned()
    {
        let (w, h) = state.dashboard.office.viewport;
        let area = layout(Rect::new(0, 0, w, h), state).inspector;
        let total = inspector_lines(state, &a, area.w.saturating_sub(2) as usize).len();
        let end = total.saturating_sub(area.h.saturating_sub(5) as usize);
        let current = if state.dashboard.office.paused {
            state.dashboard.office.inspector_offset.min(end)
        } else {
            end
        };
        let next = (current as i64 + delta as i64).clamp(0, end as i64) as usize;
        state.dashboard.office.inspector_offset = next;
        state.dashboard.office.paused = delta < 0 || next < end;
    } else {
        state.dashboard_scroll = (state.dashboard_scroll as i64 + delta as i64).max(0) as usize;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    fn send(state: &mut AppState, json: &str) {
        state.apply_message(sonic_rs::from_str(json).unwrap());
    }
    fn state() -> AppState {
        let mut s = AppState::default();
        s.active_tab = crate::state::TabId::Swarm;
        s.tab_locked = true;
        for name in ["bee", "builder", "builder#2", "verifier"] {
            s.workers.workers.push(Worker::new(name));
        }
        s
    }

    #[test]
    fn live_instances_are_not_merged_with_profile_seats_and_positions_survive_activity() {
        let mut s = state();
        let before: Vec<_> = seats(Rect::new(0, 0, 160, 24), &s, &agents(&s), false)
            .into_iter()
            .map(|(i, r)| (agents(&s)[i].worker.name.clone(), r))
            .collect();
        send(
            &mut s,
            r##"{"type":"tool_call","agent":"builder#2","tool":"fs_write","call_id":"a","args_summary":"file","bee_state":"writing","at":1}"##,
        );
        let after: Vec<_> = seats(Rect::new(0, 0, 160, 24), &s, &agents(&s), false)
            .into_iter()
            .map(|(i, r)| (agents(&s)[i].worker.name.clone(), r))
            .collect();
        assert_eq!(before, after);
        let cast = agents(&s);
        assert_eq!(
            cast.iter()
                .filter(|a| a.worker.name.starts_with("builder"))
                .count(),
            2
        );
        assert!(state_label(
            &s,
            cast.iter().find(|a| a.worker.name == "builder#2").unwrap()
        )
        .0
        .contains("fs_write"));
        assert!(!state_label(
            &s,
            cast.iter().find(|a| a.worker.name == "builder").unwrap()
        )
        .0
        .contains("fs_write"));
    }

    #[test]
    fn inspector_selection_survives_resize_and_clips_without_touching_neighbors() {
        let mut s = state();
        select(&mut s, "builder#2".into());
        send(
            &mut s,
            r##"{"type":"thought_chunk","coordinator":"builder#2","phase":"thinking","content":"REASON_DETAIL"}"##,
        );
        for (w, h) in [(160, 45), (120, 30), (80, 24), (40, 15)] {
            let mut canvas = Canvas::new(w, h);
            canvas.fill_rect(canvas.area(), 'X', Style::new().fg(RED));
            let area = Rect::new(1, 1, w - 2, h - 2);
            render(&mut canvas, area, &s);
            assert_eq!(s.dashboard.office.selected.as_deref(), Some("builder#2"));
            let rows = canvas.to_text_rows();
            assert!(rows
                .iter()
                .all(|row| row.starts_with('X') && row.ends_with('X')));
            assert!(rows.iter().any(|row| row.contains("Tarea:")));
            assert!(!rows.iter().any(|row| row.contains("REASON_DETAIL")));
        }
    }

    #[test]
    fn detail_shortcuts_preserve_prompt_and_return_to_live() {
        let mut s = state();
        select(&mut s, "builder#2".into());
        crate::controller::handle_key_event(
            &mut s,
            KeyEvent::new(KeyCode::Char('e'), KeyModifiers::ALT),
        );
        assert!(s.dashboard.office.expanded);
        s.dashboard.office.paused = true;
        crate::controller::handle_key_event(&mut s, KeyEvent::new(KeyCode::End, KeyModifiers::ALT));
        assert!(!s.dashboard.office.paused);
        s.input.set("keep typing");
        crate::controller::handle_key_event(
            &mut s,
            KeyEvent::new(KeyCode::Char('e'), KeyModifiers::ALT),
        );
        assert_eq!(s.input.value(), "keep typing");
        assert!(s.dashboard.office.expanded);
    }

    #[test]
    fn topology_uses_real_delegations_and_resolved_dependencies_only() {
        let mut s = state();
        assert!(edges(&s, &agents(&s)).is_empty());
        send(
            &mut s,
            r#"{"type":"swarm_collaboration","event_id":"e","delegation_id":"d","from":"bee","to":"builder","kind":"delegation","summary":"work","at":1}"#,
        );
        assert_eq!(edges(&s, &agents(&s)).len(), 1);
        send(
            &mut s,
            r#"{"type":"esperando","agent":"verifier","esperando_a":["TASK_REF_UNRESOLVED"],"razon":"dependencia","at":1}"#,
        );
        assert_eq!(edges(&s, &agents(&s)).len(), 1);
        let verifier = agents(&s)
            .into_iter()
            .find(|a| a.worker.name == "verifier")
            .unwrap();
        assert!(state_label(&s, &verifier).0.contains("TASK_REF_UNRESOLVED"));
    }
    #[test]
    fn late_worker_updates_cannot_replace_the_current_task_file_or_description() {
        let mut s = state();
        send(
            &mut s,
            r#"{"type":"task_update","task_id":"current","status":"running"}"#,
        );
        send(
            &mut s,
            r#"{"type":"worker_update","task_id":"current","worker":"builder","phase":"work","status":"running","current_action":"CURRENT_TASK","current_file":"current.rs"}"#,
        );
        send(
            &mut s,
            r#"{"type":"worker_update","task_id":"old","worker":"builder","phase":"old","status":"done","current_action":"OLD_TASK","current_file":"old.rs"}"#,
        );
        let a = agents(&s)
            .into_iter()
            .find(|a| a.telemetry == "builder")
            .unwrap();
        assert_eq!(task(&s, &a), "CURRENT_TASK");
        assert_eq!(a.worker.current_file.as_deref(), Some("current.rs"));
        assert!(state_label(&s, &a).0.contains("trabajando"));
    }

    #[test]
    fn approval_is_visible_and_phase_roles_with_multiple_instances_are_ambiguous() {
        let mut s = state();
        send(
            &mut s,
            r#"{"type":"tool_approval_request","request_id":"a","agent":"builder","tool":"shell_executor","summary":"test","detail":"detail"}"#,
        );
        s.promote_tool_approval();
        let a = agents(&s)
            .into_iter()
            .find(|a| a.telemetry == "builder")
            .unwrap();
        assert!(state_label(&s, &a).0.contains("aprobación"));
        s.plan.current = Some(crate::state::PlanEntry {
            phases: vec![
                crate::state::PlanPhase {
                    name: "build".into(),
                    coordinator: "builder".into(),
                    ..Default::default()
                },
                crate::state::PlanPhase {
                    name: "verify".into(),
                    coordinator: "verifier".into(),
                    depends_on: vec!["build".into()],
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        assert!(edges(&s, &agents(&s)).is_empty());
        s.plan.current.as_mut().unwrap().phases[0].coordinator = "builder#2".into();
        assert_eq!(edges(&s, &agents(&s)).len(), 1);
    }
    #[test]
    fn idle_scene_has_a_central_nucleus_six_hexagons_and_original_characters() {
        let mut s = state();
        for id in ["planner", "scout", "spider"] {
            s.workers.workers.push(Worker::new(id));
        }
        let area = Rect::new(0, 0, 160, 27);
        let cast = agents(&s);
        let cells = seats(area, &s, &cast, false);
        let bee = cells
            .iter()
            .find(|(i, _)| base(&cast[*i].worker.name) == "bee")
            .unwrap()
            .1;
        assert_eq!(bee.x + bee.w / 2, area.w / 2);
        assert_eq!(cells.len(), 7);
        assert!(cells.iter().any(|(_, r)| r.y < bee.y));
        assert!(cells.iter().any(|(_, r)| r.y > bee.y));
        assert!(cells.iter().any(|(_, r)| r.x < bee.x));
        assert!(cells.iter().any(|(_, r)| r.x > bee.x));
        let mut canvas = Canvas::new(area.w, area.h);
        render(&mut canvas, area, &s);
        let idle = canvas.to_text_rows().join("\n");
        assert!(idle.contains("NÚCLEO"));
        assert!(idle.contains('╱') && idle.contains('╲'));
        assert!(idle.contains('▀') || idle.contains('▄'));
        assert!(!idle.contains("sin tarea asignada"));
        s.anim_tick = 1;
        render(&mut canvas, area, &s);
        assert_eq!(
            idle,
            canvas.to_text_rows().join("\n"),
            "reposo no simula trabajo"
        );
        send(
            &mut s,
            r#"{"type":"tool_call","agent":"scout","tool":"fs_read","call_id":"read","args_summary":"src/a","bee_state":"reading","at":1}"#,
        );
        s.anim_tick = 0;
        render(&mut canvas, area, &s);
        let working = canvas.to_text_rows();
        s.anim_tick = 1;
        render(&mut canvas, area, &s);
        assert_ne!(
            working,
            canvas.to_text_rows(),
            "el personaje activo debe animarse"
        );
    }
}
