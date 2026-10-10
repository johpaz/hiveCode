//! A terminal office whose movement is driven by swarm telemetry, never random.
use super::dashboard_layout::{agent_live_line, is_replaced_worker, short_arg};
use crate::{
    state::{AppState, BeeState, Worker, WorkerStatus},
    term::{
        Canvas, Color, Rect, Style, AMBER_BRIGHT, BG_ELEVATED, BG_PANEL, DIM, GREEN, RED,
        SECONDARY, WHITE, YELLOW,
    },
    ui::{fmt_tokens, truncate_cells},
};

const DESK: u16 = 40;
const CONSULT: u16 = 8;
const EXECUTE: u16 = 70;
const WAIT: u16 = 92;

#[derive(Clone)]
pub(crate) struct OfficeAgent {
    pub worker: Worker,
    telemetry: String,
    blocked: Vec<String>,
}

/// Merge workers with roster identities, preferring live worker data over idle seats.
pub(crate) fn agents(state: &AppState) -> Vec<OfficeAgent> {
    let mut result = std::collections::BTreeMap::new();
    for roster in state.roster.by_id.values() {
        let mut worker = Worker::new(&roster.rol);
        worker.display_name = roster.alias.clone();
        worker.detail = Some(roster.funcion.clone());
        let blocked = roster
            .blocked_by()
            .into_iter()
            .map(str::to_string)
            .collect();
        result.insert(
            super::office_art::profile_key(&worker.name),
            OfficeAgent {
                worker,
                telemetry: roster.id.clone(),
                blocked,
            },
        );
    }
    for worker in &state.workers.workers {
        if is_replaced_worker(worker, state) {
            continue;
        }
        let roster = state
            .roster
            .by_id
            .get(&worker.name)
            .or_else(|| {
                state
                    .roster
                    .by_role
                    .get(&worker.name)
                    .and_then(|id| state.roster.by_id.get(id))
            })
            .or_else(|| {
                let key = super::office_art::profile_key(&worker.name);
                state
                    .roster
                    .by_id
                    .values()
                    .find(|entry| super::office_art::profile_key(&entry.rol) == key)
            });
        let mut live = worker.clone();
        let mut telemetry = worker.name.clone();
        let mut blocked = Vec::new();
        if let Some(roster) = roster {
            live.name = roster.rol.clone();
            live.display_name = roster.alias.clone();
            telemetry = roster.id.clone();
            blocked = roster
                .blocked_by()
                .into_iter()
                .map(str::to_string)
                .collect();
        }
        let key = super::office_art::profile_key(&live.name);
        if result
            .get(&key)
            .is_some_and(|agent: &OfficeAgent| agent.worker.status == WorkerStatus::Running)
            && live.status == WorkerStatus::Waiting
        {
            continue;
        }
        result.insert(
            key,
            OfficeAgent {
                worker: live,
                telemetry,
                blocked,
            },
        );
    }
    // A forensic replacement removes the idle roster seat as well as the worker.
    result.retain(|_, agent| {
        !is_replaced_worker(&agent.worker, state)
            && !state
                .workers
                .workers
                .iter()
                .any(|w| w.replaces_worker.as_deref() == Some(&agent.telemetry))
    });
    let mut agents: Vec<_> = result.into_values().collect();
    let order = ["bee", "planner", "scout", "builder", "verifier", "spider"];
    agents.sort_by_key(|agent| order.iter().position(|role| *role == super::office_art::profile_key(&agent.worker.name)).unwrap_or(order.len()));
    agents
}

fn call<'a>(state: &'a AppState, agent: &OfficeAgent) -> Option<&'a crate::state::ToolCall> {
    state
        .swarm
        .calls_for(&agent.telemetry)
        .into_iter()
        .chain(state.swarm.calls_for(&agent.worker.name))
        .min_by_key(|call| (call.started_at, &call.call_id))
}

fn waiting<'a>(state: &'a AppState, agent: &OfficeAgent) -> Option<&'a crate::state::WaitingAgent> {
    state
        .swarm
        .waiting
        .get(&agent.telemetry)
        .or_else(|| state.swarm.waiting.get(&agent.worker.name))
}

fn destination(state: &AppState, agent: &OfficeAgent) -> u16 {
    if matches!(
        agent.worker.status,
        WorkerStatus::Failed | WorkerStatus::Done
    ) {
        return DESK;
    }
    if waiting(state, agent).is_some() || !agent.blocked.is_empty() {
        return WAIT;
    }
    match call(state, agent).map(|call| call.bee_state) {
        Some(BeeState::Reading | BeeState::Searching) => CONSULT,
        Some(BeeState::Executing) => EXECUTE,
        _ => DESK,
    }
}

fn activity(state: &AppState, agent: &OfficeAgent) -> (String, Color) {
    if let Some(wait) = waiting(state, agent) {
        return (
            format!("{} · {}", wait.reason_label(), wait.waiting_for.join(", ")),
            YELLOW,
        );
    }
    if !agent.blocked.is_empty() {
        return (format!("MCP apagado: {}", agent.blocked.join(", ")), YELLOW);
    }
    if let Some(call) = call(state, agent) {
        return (
            format!(
                "{} · {} · {}",
                call.bee_state.label(),
                call.tool,
                short_arg(&call.args_summary)
            ),
            call.bee_state.color(),
        );
    }
    let mut worker = agent.worker.clone();
    if state.swarm.last_tool.contains_key(&agent.telemetry) {
        worker.name = agent.telemetry.clone();
    }
    let (line, color) = agent_live_line(state, &worker);
    match worker.status {
        WorkerStatus::Failed => (format!("falló · {line}"), RED),
        WorkerStatus::Warn => (format!("alerta · {line}"), YELLOW),
        WorkerStatus::Done => (format!("✓ listo · {line}"), GREEN),
        WorkerStatus::Waiting if !state.swarm.last_tool.contains_key(&worker.name) => {
            ("disponible".into(), DIM)
        }
        _ => (line, color),
    }
}

pub fn tick(state: &mut AppState) {
    let agents = agents(state);
    let names: std::collections::HashSet<_> =
        agents.iter().map(|a| a.worker.name.as_str()).collect();
    state
        .dashboard
        .office
        .positions
        .retain(|name, _| names.contains(name.as_str()));
    state
        .dashboard
        .office
        .targets
        .retain(|name, _| names.contains(name.as_str()));
    state
        .dashboard
        .office
        .routes
        .retain(|name, _| names.contains(name.as_str()));
    if state
        .dashboard
        .office
        .selected
        .as_ref()
        .is_some_and(|name| !names.contains(name.as_str()))
    {
        state.dashboard.office.selected = None;
    }
    state
        .dashboard
        .office
        .homes
        .retain(|name, _| names.contains(name.as_str()));
    let (w, h) = state.dashboard.office.viewport;
    let (w, h) = if w == 0 || h == 0 { (120, 24) } else { (w, h) };
    let scene = super::office_scene::Scene::new(
        Rect::new(0, 0, w, h),
        state,
        agents.len(),
        w < 60 || h < 10,
    );
    for (index, station) in &scene.stations {
        let agent = &agents[*index];
        let name = &agent.worker.name;
        state
            .dashboard
            .office
            .homes
            .insert(name.clone(), super::office_scene::Scene::chair(*station));
        let target = scene.target(*index, *station, destination(state, agent));
        let position = *state
            .dashboard
            .office
            .positions
            .entry(name.clone())
            .or_insert(super::office_scene::Scene::chair(*station));
        if state.dashboard.office.targets.get(name) != Some(&target) {
            state
                .dashboard
                .office
                .routes
                .insert(name.clone(), scene.route(position, target));
            state.dashboard.office.targets.insert(name.clone(), target);
        }
        if !state.dashboard.halt.active {
            for _ in 0..3 {
                if let Some(next) = state
                    .dashboard
                    .office
                    .routes
                    .get_mut(name)
                    .and_then(|route| route.pop_front())
                {
                    state.dashboard.office.positions.insert(name.clone(), next);
                }
            }
        }
    }
}

pub fn select_next(state: &mut AppState, direction: i32) {
    let agents = agents(state);
    if agents.is_empty() {
        return;
    }
    let current = agents
        .iter()
        .position(|a| Some(&a.worker.name) == state.dashboard.office.selected.as_ref());
    let index = match current {
        Some(index) => (index as i32 + direction).rem_euclid(agents.len() as i32) as usize,
        None if direction < 0 => agents.len() - 1,
        None => 0,
    };
    state.dashboard.office.selected = Some(agents[index].worker.name.clone());
    state.dashboard_scroll = index;
}

pub(crate) fn code_worker(state: &AppState, role: &str) -> String {
    state
        .workers
        .workers
        .iter()
        .find(|worker| {
            worker.name == role
                || state
                    .roster
                    .by_id
                    .get(&worker.name)
                    .is_some_and(|agent| agent.rol == role)
        })
        .or_else(|| {
            let key = super::office_art::profile_key(role);
            state
                .workers
                .workers
                .iter()
                .find(|worker| super::office_art::profile_key(&worker.name) == key)
        })
        .map(|worker| worker.name.clone())
        .unwrap_or_else(|| role.to_string())
}

struct Layout {
    floor: Rect,
    inspector: Rect,
    compact: bool,
}

fn layout(area: Rect, state: &AppState) -> Layout {
    let compact = area.w < 60 || area.h < 10;
    let selected = state.dashboard.office.selected.is_some();
    if selected && compact {
        Layout {
            floor: Rect::default(),
            inspector: area,
            compact,
        }
    } else if selected && area.w >= 100 && area.h >= 8 {
        Layout {
            floor: Rect::new(area.x, area.y, area.w - 33, area.h),
            inspector: Rect::new(area.right() - 32, area.y, 32, area.h),
            compact,
        }
    } else if selected && area.h >= 8 {
        let h = 6.min(area.h / 2);
        Layout {
            floor: Rect::new(area.x, area.y, area.w, area.h - h),
            inspector: Rect::new(area.x, area.bottom() - h, area.w, h),
            compact: area.h - h < 10,
        }
    } else {
        Layout {
            floor: area,
            inspector: Rect::default(),
            compact,
        }
    }
}

fn seats(area: Rect, state: &AppState, count: usize, compact: bool) -> Vec<(usize, Rect)> {
    super::office_scene::Scene::new(area, state, count, compact).stations
}

fn actor_position(state: &AppState, name: &str, station: Rect, floor: Rect) -> (u16, u16) {
    let Some(&(x, y)) = state.dashboard.office.positions.get(name) else {
        return super::office_scene::Scene::chair(station);
    };
    let (w, h) = state.dashboard.office.viewport;
    let (w, h) = if w == 0 || h == 0 { (120, 24) } else { (w, h) };
    let home = state
        .dashboard
        .office
        .homes
        .get(name)
        .copied()
        .unwrap_or((x, y));
    let chair = super::office_scene::Scene::chair(station);
    (
        (chair.0 as i32 + (x as i32 - home.0 as i32) * floor.w as i32 / w as i32).clamp(
            floor.x as i32 + 1,
            (floor.right().saturating_sub(super::office_art::WIDTH + 1)).max(floor.x + 1) as i32,
        ) as u16,
        (chair.1 as i32 + (y as i32 - home.1 as i32) * floor.h as i32 / h as i32).clamp(
            floor.y as i32 + 1,
            (floor.bottom().saturating_sub(super::office_art::HEIGHT + 1)).max(floor.y + 1) as i32,
        ) as u16,
    )
}

pub fn worker_at(state: &AppState, area: Rect, x: u16, y: u16) -> Option<String> {
    let agents = agents(state);
    let layout = layout(area, state);
    let seats = seats(layout.floor, state, agents.len(), layout.compact);
    if !layout.compact {
        for (index, station) in &seats {
            let point = actor_position(state, &agents[*index].worker.name, *station, layout.floor);
            if super::office_art::bounds(point.0, point.1).contains(x, y) {
                return Some(agents[*index].worker.name.clone());
            }
        }
    }
    seats
        .into_iter()
        .find(|(_, rect)| rect.contains(x, y))
        .map(|(index, _)| agents[index].worker.name.clone())
}

pub fn register_hits(state: &mut AppState, area: Rect) {
    let agents = agents(state);
    let layout = layout(area, state);
    let size = (layout.floor.w, layout.floor.h);
    if size != state.dashboard.office.viewport && size.0 > 0 && size.1 > 0 {
        let placements = seats(layout.floor, state, agents.len(), layout.compact);
        let points: Vec<_> = placements
            .iter()
            .map(|(index, station)| {
                let name = &agents[*index].worker.name;
                let point = actor_position(state, name, *station, layout.floor);
                let home = super::office_scene::Scene::chair(*station);
                (
                    name.clone(),
                    (point.0 - layout.floor.x, point.1 - layout.floor.y),
                    (home.0 - layout.floor.x, home.1 - layout.floor.y),
                )
            })
            .collect();
        state.dashboard.office.positions.clear();
        state.dashboard.office.homes.clear();
        for (name, point, home) in points {
            state.dashboard.office.positions.insert(name.clone(), point);
            state.dashboard.office.homes.insert(name, home);
        }
        state.dashboard.office.viewport = size;
        state.dashboard.office.targets.clear();
        state.dashboard.office.routes.clear();
    }
    for (index, rect) in seats(layout.floor, state, agents.len(), layout.compact) {
        let name = &agents[index].worker.name;
        let id = format!("office:select:{name}");
        state.hit_map.push(crate::ui::MouseRegion::new(
            &id,
            rect,
            1,
            crate::ui::HitAction::Custom(id.clone()),
        ));
        if !layout.compact {
            let point = actor_position(state, name, rect, layout.floor);
            state.hit_map.push(crate::ui::MouseRegion::new(
                &id,
                super::office_art::bounds(point.0, point.1),
                3,
                crate::ui::HitAction::Custom(id.clone()),
            ));
        }
    }
}

fn text(canvas: &mut Canvas, area: Rect, row: u16, value: &str, color: Color) {
    if row < area.h {
        canvas.print(
            area.x,
            area.y + row,
            &truncate_cells(value, area.w as usize),
            Style::new().fg(color),
        );
    }
}

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.w < 2 || area.h == 0 {
        return;
    }
    let agents = agents(state);
    let layout = layout(area, state);
    let scene = super::office_scene::Scene::new(layout.floor, state, agents.len(), layout.compact);
    canvas.with_clip(area, |canvas| {
        canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
        if !layout.compact {
            scene.draw(canvas);
        }
        text(
            canvas,
            layout.floor,
            0,
            "OFICINA / COLMENA   ·   Alt+↑/↓ seleccionar   Enter Código",
            AMBER_BRIGHT,
        );
        if agents.is_empty() {
            text(
                canvas,
                layout.floor,
                2,
                "Sin agentes · esperando roster del enjambre",
                DIM,
            );
        }
        for (index, station) in &scene.stations {
            let agent = &agents[*index];
            let selected = state.dashboard.office.selected.as_deref() == Some(&agent.worker.name);
            let (activity, color) = activity(state, agent);
            let mark = if selected { ">" } else { " " };
            let role = super::office_art::profile_key(&agent.worker.name);
            let identity = match role.as_str() {
                "bee" => "BEE",
                "planner" => "Planner",
                "scout" => "Scout",
                "builder" => "Builder",
                "verifier" => "Quality Gate",
                "spider" => "Spider",
                _ => agent.worker.display_name.as_str(),
            };
            let name = format!("{mark}@{}", identity.to_uppercase());
            if layout.compact {
                text(canvas, *station, 0, &format!("{name} · {activity}"), color);
                text(canvas, *station, 1, &agent.worker.name, SECONDARY);
            } else {
                if selected {
                    for row in 0..4 {
                        canvas.print(
                            station.x,
                            station.y + row,
                            "▎",
                            Style::new().fg(AMBER_BRIGHT),
                        );
                    }
                }
                let label = Rect::new(station.x + 1, station.y + 4, station.w.saturating_sub(2), 2);
                text(
                    canvas,
                    label,
                    0,
                    &name,
                    if selected { AMBER_BRIGHT } else { WHITE },
                );
                text(canvas, label, 1, &activity, color);
                if station.w >= 34 {
                    let role = agent.worker.display_name.to_uppercase();
                    let width = unicode_width::UnicodeWidthStr::width(role.as_str()) as u16;
                    if role != identity.to_uppercase()
                        && width + unicode_width::UnicodeWidthStr::width(name.as_str()) as u16 + 4
                            < label.w
                    {
                        canvas.print(
                            label.right() - width,
                            label.y,
                            &role,
                            Style::new().fg(SECONDARY),
                        );
                    }
                }
                // A monitor lights up only when this agent actually has work.
                let screen = if call(state, agent).is_some()
                    || agent.worker.status == WorkerStatus::Running
                {
                    color
                } else {
                    DIM
                };
                canvas.print(
                    station.x + 3,
                    station.y + 1,
                    if state.anim_tick % 2 == 0 {
                        ">_  "
                    } else {
                        "> ▂ "
                    },
                    Style::new().fg(screen),
                );
            }
        }
        // Furniture is painted first. Actors are composited by depth, with transparency.
        let mut actors: Vec<_> = scene
            .stations
            .iter()
            .map(|(index, station)| {
                let agent = &agents[*index];
                (
                    actor_position(state, &agent.worker.name, *station, layout.floor),
                    agent,
                )
            })
            .collect();
        actors.sort_by_key(|(point, _)| point.1);
        if !layout.compact {
            for (point, agent) in actors {
                let moving = state
                    .dashboard
                    .office
                    .routes
                    .get(&agent.worker.name)
                    .is_some_and(|route| !route.is_empty());
                let active = moving
                    || call(state, agent).is_some()
                    || agent.worker.status == WorkerStatus::Running;
                let selected =
                    state.dashboard.office.selected.as_deref() == Some(&agent.worker.name);
                super::office_art::draw(
                    canvas,
                    point.0,
                    point.1,
                    &agent.worker.name,
                    state.anim_tick,
                    active && !state.dashboard.halt.active,
                    selected,
                );
                if let Some(call) = call(state, agent) {
                    let prop = match call.bee_state {
                        BeeState::Reading => "▤",
                        BeeState::Writing => "✎",
                        BeeState::Searching => "⌕",
                        BeeState::Executing => ">",
                        _ => "",
                    };
                    canvas.print(
                        point.0 + super::office_art::WIDTH,
                        point.1 + 2,
                        prop,
                        Style::new().fg(call.bee_state.color()),
                    );
                }
                let (_, color) = activity(state, agent);
                let badge = match agent.worker.status {
                    WorkerStatus::Done => "✓",
                    WorkerStatus::Failed => "!",
                    _ if waiting(state, agent).is_some() => "…",
                    _ => "",
                };
                canvas.print(
                    point.0 + super::office_art::WIDTH,
                    point.1,
                    badge,
                    Style::new().fg(color),
                );
            }
        }
        let start = scene
            .stations
            .first()
            .map(|(index, _)| index + 1)
            .unwrap_or(0);
        let end = scene
            .stations
            .last()
            .map(|(index, _)| index + 1)
            .unwrap_or(0);
        let summary = if state.dashboard.halt.active {
            format!(
                "HALT · {}",
                state
                    .dashboard
                    .halt
                    .reason
                    .as_deref()
                    .unwrap_or("enjambre detenido")
            )
        } else if let Some(conflict) = state.conflicts.entries.first() {
            format!(
                "CONFLICTO · {} / {} · {}",
                conflict.agent_a, conflict.agent_b, conflict.path
            )
        } else if state.dashboard.security.status != "OFFLINE" {
            format!(
                "SEGURIDAD · {} · {} hallazgos",
                state.dashboard.security.status, state.dashboard.security.findings
            )
        } else {
            format!(
                "puestos {start}–{end}/{}   ·   rueda / PgUp/PgDn   ·   pizarra compartida ↓",
                agents.len()
            )
        };
        if layout.floor.h >= 4 {
            text(
                canvas,
                layout.floor,
                layout.floor.h - 1,
                &summary,
                if state.dashboard.halt.active || !state.conflicts.entries.is_empty() {
                    RED
                } else {
                    SECONDARY
                },
            );
        }
        if let Some(agent) = agents
            .iter()
            .find(|a| state.dashboard.office.selected.as_deref() == Some(&a.worker.name))
        {
            inspector(canvas, layout.inspector, state, agent);
        }
    });
}

fn inspector(canvas: &mut Canvas, area: Rect, state: &AppState, agent: &OfficeAgent) {
    if area.h == 0 {
        return;
    }
    canvas.with_clip(area, |canvas| {
        canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
        let mut content = area;
        if area.h >= 16 && area.w >= 28 {
            canvas.draw_border(area, Style::new().fg(SECONDARY).bg(BG_ELEVATED));
            canvas.print(
                area.x + 2,
                area.y,
                " AGENTE ",
                Style::new().fg(AMBER_BRIGHT).bg(BG_ELEVATED),
            );
            super::office_art::draw(
                canvas,
                area.x + 3,
                area.y + 2,
                &agent.worker.name,
                state.anim_tick,
                false,
                false,
            );
            content = Rect::new(area.x + 2, area.y + 6, area.w - 4, area.h - 7);
        }
        let (activity, color) = activity(state, agent);
        let lines = [
            format!("@{} · {}", agent.worker.display_name, agent.worker.name),
            activity,
            format!(
                "Tarea: {}",
                agent
                    .worker
                    .current_action
                    .as_deref()
                    .or(agent.worker.detail.as_deref())
                    .unwrap_or("sin tarea asignada")
            ),
            format!(
                "Archivo: {}",
                agent
                    .worker
                    .current_file
                    .as_deref()
                    .unwrap_or("sin archivo activo")
            ),
            format!(
                "iter {}/{} · tokens {}",
                agent.worker.iteration_current.unwrap_or(0),
                agent.worker.iteration_total.unwrap_or(0),
                fmt_tokens(agent.worker.token_count)
            ),
            "Enter: Código · Esc: cerrar".into(),
        ];
        let mut row = 0;
        for (index, line) in lines.iter().enumerate() {
            let color = if index == 0 {
                AMBER_BRIGHT
            } else if index == 1 {
                color
            } else {
                SECONDARY
            };
            let mut part = String::new();
            for word in line.split_whitespace() {
                if !part.is_empty()
                    && unicode_width::UnicodeWidthStr::width(part.as_str())
                        + 1
                        + unicode_width::UnicodeWidthStr::width(word)
                        > content.w as usize
                {
                    text(canvas, content, row, &part, color);
                    row += 1;
                    part.clear();
                }
                for ch in word.chars() {
                    if unicode_width::UnicodeWidthStr::width(part.as_str())
                        + unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0)
                        > content.w as usize
                    {
                        text(canvas, content, row, &part, color);
                        row += 1;
                        part.clear();
                    }
                    part.push(ch);
                }
                part.push(' ');
            }
            text(canvas, content, row, part.trim_end(), color);
            row += 1;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ipc::IpcRosterAgent,
        state::{ToolCall, WaitingAgent},
    };

    #[test]
    fn live_ids_replace_idle_profile_seats_without_losing_transport_identity() {
        let mut state = AppState::default();
        state.workers.workers.push(Worker::new("BEE"));
        assert_eq!(code_worker(&state, "bee"), "BEE");
        state.workers.workers.clear();
        for (profile, id) in [("BEE", "bee"), ("Quality Gate", "verifier")] {
            state.workers.workers.push(Worker::new(profile));
            let mut worker = Worker::new(id);
            worker.status = WorkerStatus::Running;
            state.workers.workers.push(worker);
        }
        let cast = agents(&state);
        assert_eq!(cast.len(), 2);
        for agent in &cast {
            assert_eq!(agent.worker.status, WorkerStatus::Running);
            assert_eq!(agent.telemetry, agent.worker.name);
            assert!(matches!(agent.worker.name.as_str(), "bee" | "verifier"));
            assert_eq!(code_worker(&state, &agent.worker.name), agent.worker.name);
        }
        state.workers.workers.reverse();
        assert!(agents(&state)
            .iter()
            .all(|agent| agent.worker.status == WorkerStatus::Running));
    }

    fn state() -> AppState {
        let mut state = AppState::default();
        state.dashboard.office.viewport = (120, 24);
        let mut worker = Worker::new("backend");
        worker.status = WorkerStatus::Running;
        state.workers.workers.push(worker);
        state
    }

    fn target(state: &AppState, zone: u16) -> (u16, u16) {
        let scene =
            super::super::office_scene::Scene::new(Rect::new(0, 0, 120, 24), state, 1, false);
        scene.target(0, scene.stations[0].1, zone)
    }

    fn start(state: &mut AppState, activity: BeeState) {
        state.swarm.start_call(ToolCall {
            call_id: "call".into(),
            agent: "backend".into(),
            tool: "fs_read".into(),
            args_summary: r#"{"path":"src/main.rs"}"#.into(),
            bee_state: activity,
            started_at: 1,
            settled: false,
            ok: None,
            duration_ms: None,
        });
    }

    #[test]
    fn activity_moves_to_real_destinations_and_returns_after_completion() {
        for (activity, expected) in [
            (BeeState::Reading, CONSULT),
            (BeeState::Searching, CONSULT),
            (BeeState::Executing, EXECUTE),
            (BeeState::Writing, DESK),
            (BeeState::Thinking, DESK),
        ] {
            let mut state = state();
            start(&mut state, activity);
            for _ in 0..200 {
                tick(&mut state);
            }
            assert_eq!(
                state.dashboard.office.positions["backend"],
                target(&state, expected)
            );
            state.swarm.settle_call("call", true, 200);
            for _ in 0..200 {
                tick(&mut state);
            }
            assert_eq!(
                state.dashboard.office.positions["backend"],
                target(&state, DESK)
            );
        }
    }

    #[test]
    fn halt_freezes_motion_and_waiting_shows_dependencies() {
        let mut state = state();
        start(&mut state, BeeState::Reading);
        tick(&mut state);
        let position = state.dashboard.office.positions["backend"];
        state.dashboard.halt.active = true;
        for _ in 0..200 {
            tick(&mut state);
        }
        assert_eq!(state.dashboard.office.positions["backend"], position);
        state.dashboard.halt.active = false;
        state.swarm.settle_call("call", true, 100);
        state.swarm.set_waiting(WaitingAgent {
            agent: "backend".into(),
            waiting_for: vec!["frontend".into()],
            reason: "dependencia".into(),
            since: 1,
        });
        for _ in 0..200 {
            tick(&mut state);
        }
        assert_eq!(
            state.dashboard.office.positions["backend"],
            target(&state, WAIT)
        );
        assert!(activity(&state, &agents(&state)[0]).0.contains("frontend"));
    }

    #[test]
    fn roster_ids_and_worker_roles_share_one_seat_and_telemetry() {
        let mut state = state();
        state.roster.apply(vec![IpcRosterAgent {
            id: "agent-topo".into(),
            rol: "backend".into(),
            alias: "Topo".into(),
            funcion: "Servicios".into(),
            nivel: 2,
            tools: vec![],
            mcp: vec![],
        }]);
        start(&mut state, BeeState::Executing);
        let mut call = state.swarm.in_flight.remove("call").unwrap();
        call.agent = "agent-topo".into();
        state.swarm.start_call(call);
        assert_eq!(agents(&state).len(), 1);
        assert_eq!(destination(&state, &agents(&state)[0]), EXECUTE);
        assert!(activity(&state, &agents(&state)[0])
            .0
            .contains("src/main.rs"));
        state.workers.workers[0].name = "agent-topo".into();
        assert_eq!(agents(&state).len(), 1);
        assert_eq!(code_worker(&state, "backend"), "agent-topo");
        let mut replacement = Worker::new("forensic:backend");
        replacement.replaces_worker = Some("agent-topo".into());
        state.workers.workers.push(replacement);
        assert_eq!(agents(&state).len(), 1);
        assert_eq!(agents(&state)[0].worker.name, "forensic:backend");
    }

    #[test]
    fn removal_clears_selection_and_idle_agents_do_not_walk() {
        let mut state = state();
        select_next(&mut state, 1);
        tick(&mut state);
        assert_eq!(
            state.dashboard.office.positions["backend"],
            target(&state, DESK)
        );
        state.workers.workers.clear();
        tick(&mut state);
        assert!(state.dashboard.office.selected.is_none());
        assert!(state.dashboard.office.positions.is_empty());
    }

    #[test]
    fn resize_preserves_selection_and_hits_match_every_visible_person() {
        let mut state = state();
        for index in 0..12 {
            state
                .workers
                .workers
                .push(Worker::new(format!("worker-{index}")));
        }
        start(&mut state, BeeState::Reading);
        tick(&mut state);
        let position = state.dashboard.office.positions["backend"];
        for (w, h) in [(160, 40), (100, 24), (80, 24), (40, 12)] {
            let area = Rect::new(2, 1, w - 4, h - 2);
            let mut canvas = Canvas::new(w, h);
            render(&mut canvas, area, &state);
            let agents = agents(&state);
            let layout = layout(area, &state);
            for (index, lane) in seats(layout.floor, &state, agents.len(), layout.compact) {
                assert_eq!(
                    worker_at(&state, area, lane.x, lane.y).as_deref(),
                    Some(agents[index].worker.name.as_str())
                );
                if !layout.compact {
                    assert_eq!(
                        worker_at(
                            &state,
                            area,
                            actor_position(&state, &agents[index].worker.name, lane, layout.floor)
                                .0,
                            actor_position(&state, &agents[index].worker.name, lane, layout.floor)
                                .1
                        )
                        .as_deref(),
                        Some(agents[index].worker.name.as_str())
                    );
                }
            }
            assert!(
                canvas.to_text_rows()[0].trim().is_empty(),
                "drawing escaped its area"
            );
            state.dashboard.office.selected = Some("backend".into());
            render(&mut canvas, area, &state);
            assert!(canvas.to_text_rows().join("\n").contains("fs_read"));
            assert_eq!(state.dashboard.office.positions["backend"], position);
            assert_eq!(state.dashboard.office.selected.as_deref(), Some("backend"));
            state.dashboard.office.selected = None;
        }
    }

    #[test]
    fn selecting_overflow_agent_brings_it_into_view() {
        let mut state = state();
        for index in 0..20 {
            state
                .workers
                .workers
                .push(Worker::new(format!("worker-{index:02}")));
        }
        select_next(&mut state, -1);
        let area = Rect::new(0, 0, 100, 24);
        let layout = layout(area, &state);
        let agents = agents(&state);
        assert!(seats(layout.floor, &state, agents.len(), layout.compact)
            .iter()
            .any(|(index, _)| Some(&agents[*index].worker.name)
                == state.dashboard.office.selected.as_ref()));
    }
}
