use crate::{
    state::{AppState, BlackboardEvent},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM, SECONDARY},
    ui::{cell_width, truncate_cells},
    widgets::{components::agent_display_name, history},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    if area.w < 50 {
        history::render(canvas, area, state);
        return;
    }

    let left_w = (area.w * 65 / 100).max(20).min(area.w.saturating_sub(18));
    let right_w = area.w.saturating_sub(left_w + 1);
    let conversation = Rect::new(area.x, area.y, left_w, area.h);
    let divider_x = area.x + left_w;
    let thought = Rect::new(divider_x + 1, area.y, right_w, area.h);

    canvas.with_clip(conversation, |canvas| history::render(canvas, conversation, state));
    for y in area.y..area.bottom() {
        canvas.print(divider_x, y, "│", Style::new().fg(AMBER_DIM).bg(BG_PANEL));
    }
    canvas.with_clip(thought, |canvas| render_bee_context(canvas, thought, state));
}

fn render_bee_context(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    canvas.print(area.x + 1, area.y, "⬡ BEE THOUGHT", Style::new().fg(AMBER).bold().bg(BG_ELEVATED));
    if area.h < 3 {
        return;
    }

    let bee_chunks: Vec<_> = state
        .thought
        .chunks
        .iter()
        .filter(|chunk| chunk.coordinator == "bee")
        .collect();
    if !bee_chunks.is_empty() {
        render_thought_chunks(canvas, area, state, &bee_chunks);
        return;
    }

    let reasoning_events: Vec<_> = state
        .dashboard
        .blackboard_events
        .iter()
        .filter(|event| {
            event.agent == "bee"
                || event.event_type.eq_ignore_ascii_case("reasoning")
                || event.event_type.eq_ignore_ascii_case("memory")
        })
        .collect();
    if !reasoning_events.is_empty() {
        render_reasoning_events(canvas, area, &reasoning_events);
        return;
    }

    render_project_state(canvas, area, state);
}

fn render_thought_chunks(
    canvas: &mut Canvas,
    area: Rect,
    state: &AppState,
    chunks: &[&crate::state::ThoughtChunk],
) {
    let body_h = area.h.saturating_sub(4) as usize;
    let start = chunks.len().saturating_sub(body_h);
    let mut y = area.y + 2;
    for chunk in chunks.iter().skip(start) {
        if y >= area.bottom().saturating_sub(2) {
            break;
        }
        let clean = clean_reasoning(&chunk.content);
        if clean.trim().is_empty() {
            continue;
        }
        let phase = if chunk.phase.trim().is_empty() {
            "reasoning"
        } else {
            chunk.phase.as_str()
        };
        canvas.print(area.x + 1, y, "↳", Style::new().fg(AMBER_DIM).bg(BG_ELEVATED));
        let text = format!("{} · {}", phase.replace('_', " "), clean);
        canvas.print(
            area.x + 3,
            y,
            &truncate_cells(&text, area.w.saturating_sub(5) as usize),
            Style::new().fg(SECONDARY).bg(BG_ELEVATED),
        );
        y += 1;
    }

    if let Some(classification) = infer_bee_classification(state) {
        let y = area.bottom().saturating_sub(1);
        canvas.print(area.x + 1, y, &classification, Style::new().fg(AMBER_BRIGHT).bold().bg(BG_ELEVATED));
    }
}

fn render_reasoning_events(canvas: &mut Canvas, area: Rect, events: &[&BlackboardEvent]) {
    let body_h = area.h.saturating_sub(3) as usize;
    let start = events.len().saturating_sub(body_h);
    let mut y = area.y + 2;
    for event in events.iter().skip(start) {
        if y >= area.bottom() {
            break;
        }
        let tag = format!("[{}]", event.event_type.to_ascii_uppercase());
        canvas.print(area.x + 1, y, &tag, Style::new().fg(AMBER_BRIGHT).bold().bg(BG_ELEVATED));
        let text_x = area.x + 2 + cell_width(&tag) as u16;
        canvas.print(
            text_x,
            y,
            &truncate_cells(&event.content, area.right().saturating_sub(text_x + 1) as usize),
            Style::new().fg(SECONDARY).bg(BG_ELEVATED),
        );
        y += 1;
    }
}

fn render_project_state(canvas: &mut Canvas, area: Rect, state: &AppState) {
    let mut y = area.y + 2;
    let rows = [
        format!("proyecto: {}", state.session.project_name),
        format!("ADRs activos: {}", state.adrs.entries.len()),
        format!("memoria visible: {}", state.dashboard.blackboard_events.len()),
        state
            .review
            .verdict
            .as_ref()
            .map(|verdict| format!("@Reviewer previo: {}", verdict.status))
            .unwrap_or_else(|| "@Reviewer previo: sin veredicto".to_string()),
    ];
    for row in rows {
        if y >= area.bottom() {
            break;
        }
        canvas.print(
            area.x + 2,
            y,
            &truncate_cells(&row, area.w.saturating_sub(4) as usize),
            Style::new().fg(SECONDARY).bg(BG_ELEVATED),
        );
        y += 1;
    }

    if y + 1 < area.bottom() {
        canvas.print(area.x + 2, y + 1, "esperando razonamiento de Bee", Style::new().fg(DIM).bg(BG_ELEVATED));
    }
}

fn infer_bee_classification(state: &AppState) -> Option<String> {
    let last = state
        .thought
        .chunks
        .iter()
        .rev()
        .find(|chunk| chunk.coordinator == "bee")?;
    let phase = last.phase.to_ascii_lowercase();
    let content = last.content.to_ascii_lowercase();
    for action in ["respond", "fix", "dispatch", "architecture"] {
        if phase.contains(action) || content.contains(action) {
            return Some(format!("clasificación: {} · {}", action, classification_reason(action)));
        }
    }
    Some(format!("clasificación: {}", agent_display_name("bee")))
}

fn classification_reason(action: &str) -> &'static str {
    match action {
        "respond" => "respuesta directa sin workers",
        "fix" => "cambio directo de bajo alcance",
        "dispatch" => "worker único requerido",
        "architecture" => "planificación necesaria",
        _ => "pendiente",
    }
}

fn clean_reasoning(content: &str) -> String {
    content
        .replace("<think>", "")
        .replace("</think>", "")
        .trim()
        .to_string()
}
