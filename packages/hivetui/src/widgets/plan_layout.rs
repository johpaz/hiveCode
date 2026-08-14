use crate::{
    state::{ApiContract, AppState, PlanPhase, RiskLevel, Role},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM, GREEN, PURPLE, RED, SECONDARY, YELLOW},
    ui::{
        render_split_handles, render_vertical_scrollbar, split_panes,
        Axis, Constraint, ScrollbarState, SplitPane,
    },
    widgets::components::{
        agent_display_name, push_wrapped_lines, truncate_cells, worker_color, StyledLine,
    },
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if area.w < 40 {
        return;
    }

    if area.w < 90 {
        let split = SplitPane::new(
            Axis::Horizontal,
            vec![Constraint::Percent(62), Constraint::Fill(1)],
        );
        let (cols, handles) = split_panes(area, &split);
        canvas.with_clip(cols[0], |canvas| render_plan_pane(canvas, cols[0], state));
        render_split_handles(canvas, &handles, Axis::Horizontal);
        canvas.with_clip(cols[1], |canvas| render_architect_thought(canvas, cols[1], state));
        return;
    }

    let gap = 1;
    let left_w = (area.w * 25 / 100).max(22);
    let right_w = (area.w * 25 / 100).max(22);
    let center_w = area.w.saturating_sub(left_w + right_w + gap * 2);
    let left = Rect::new(area.x, area.y, left_w, area.h);
    let center = Rect::new(area.x + left_w + gap, area.y, center_w, area.h);
    let right = Rect::new(center.right() + gap, area.y, area.right().saturating_sub(center.right() + gap), area.h);

    canvas.with_clip(left, |canvas| render_prd_reference(canvas, left, state));
    draw_vertical_rule(canvas, left.right(), area);
    canvas.with_clip(center, |canvas| render_plan_pane(canvas, center, state));
    draw_vertical_rule(canvas, center.right(), area);
    canvas.with_clip(right, |canvas| render_architect_thought(canvas, right, state));
}

// ── Left panel: streaming reasoning + structured plan ─────────────────────────

fn render_plan_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let title = "⬡ PLAN EN CONSTRUCCIÓN";
    canvas.print(area.x + 1, area.y, title, Style::new().fg(AMBER).bold());

    if state.plan.current.is_none() && state.thought.chunks.is_empty() && state.filemap.entries.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "No hay plan activo.", Style::new().fg(DIM));
        canvas.print(area.x + 2, area.y + 3, "Envía una tarea en modo PLAN para generar uno.", Style::new().fg(DIM));
        return;
    }

    let content_w = area.w.saturating_sub(4).max(1) as usize;
    let lines = build_plan_pane_lines(state, content_w);
    let body_y = area.y + 2;
    let body_h = area.bottom().saturating_sub(body_y + 1) as usize;
    if body_h == 0 {
        return;
    }
    let scroll_offset = if state.plan.current.is_none() && !state.filemap.entries.is_empty() {
        state.filemap.scroll
    } else {
        state.plan.scroll
    };
    let scroll = ScrollbarState::new(lines.len(), body_h, scroll_offset);

    for (offset, line) in lines.iter().skip(scroll.offset).take(body_h).enumerate() {
        canvas.print(
            area.x + 1 + line.indent,
            body_y + offset as u16,
            &line.text,
            line.style,
        );
    }

    if scroll.can_scroll() {
        render_vertical_scrollbar(
            canvas,
            Rect::new(area.right().saturating_sub(1), body_y, 1, body_h as u16),
            scroll,
            Style::new().fg(AMBER_BRIGHT),
            Style::new().fg(DIM),
        );
        canvas.print(area.x + 1, area.bottom().saturating_sub(1), "↑↓/PgUp/PgDn · rueda", Style::new().fg(DIM));
    }
    // Approval hint always visible at bottom right
    let hint = "↩ ejecutar · m modificar · n regenerar";
    let hint_x = area.right().saturating_sub(hint.len() as u16 + 1);
    canvas.print(hint_x, area.bottom().saturating_sub(1), hint, Style::new().fg(AMBER_DIM));
}

fn render_prd_reference(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    canvas.print(area.x + 1, area.y, "⬡ PRD / TAREA", Style::new().fg(AMBER_BRIGHT).bold().bg(BG_ELEVATED));
    if area.h < 3 {
        return;
    }

    let source = state
        .dashboard
        .blackboard_events
        .iter()
        .rev()
        .find(|event| event.agent == "product_manager" || event.event_type.eq_ignore_ascii_case("prd"))
        .map(|event| event.content.as_str())
        .or_else(|| {
            state
                .history
                .entries
                .iter()
                .rev()
                .find(|entry| entry.role == Role::User)
                .map(|entry| entry.content.as_str())
        });

    let Some(source) = source else {
        canvas.print(area.x + 2, area.y + 2, "sin tarea activa", Style::new().fg(DIM).bg(BG_ELEVATED));
        return;
    };

    let mut y = area.y + 2;
    let width = area.w.saturating_sub(4) as usize;
    for paragraph in source.lines().filter(|line| !line.trim().is_empty()) {
        for line in wrap_plain(paragraph.trim(), width) {
            if y >= area.bottom().saturating_sub(1) {
                return;
            }
            canvas.print(area.x + 2, y, &line, Style::new().fg(SECONDARY).bg(BG_ELEVATED));
            y += 1;
        }
        if y < area.bottom().saturating_sub(1) {
            y += 1;
        }
    }
}

fn render_architect_thought(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    canvas.print(area.x + 1, area.y, "⬡ ACTIVIDAD · AGENTE", Style::new().fg(PURPLE).bold().bg(BG_ELEVATED));
    if area.h < 3 {
        return;
    }

    let architect_chunks: Vec<_> = state
        .thought
        .chunks
        .iter()
        .filter(|chunk| matches!(chunk.coordinator.as_str(), "architecture" | "architect"))
        .collect();
    let chunks: Vec<_> = if architect_chunks.is_empty() {
        state.thought.chunks.iter().collect()
    } else {
        architect_chunks
    };
    let mut y = area.y + 2;
    if !chunks.is_empty() {
        let start = chunks.len().saturating_sub(area.h.saturating_sub(3) as usize);
        for chunk in chunks.iter().skip(start) {
            if y >= area.bottom().saturating_sub(3) {
                break;
            }
            let phase = phase_label(&chunk.phase);
            let display = agent_display_name(&chunk.coordinator);
            let text = if phase.is_empty() {
                format!("{} · {}", display, clean_thought_content(&chunk.content))
            } else {
                format!("{} · {} · {}", display, phase, clean_thought_content(&chunk.content))
            };
            canvas.print(area.x + 1, y, "↳", Style::new().fg(AMBER_DIM).bg(BG_ELEVATED));
            canvas.print(
                area.x + 3,
                y,
                &truncate_cells(&text, area.w.saturating_sub(5) as usize),
                Style::new().fg(SECONDARY).bg(BG_ELEVATED),
            );
            y += 1;
        }
        if let Some(adr) = state.adrs.entries.get(state.adrs.selected).filter(|_| y + 2 < area.bottom()) {
            y += 1;
            canvas.print(area.x + 2, y, "ADR activo", Style::new().fg(AMBER_DIM).bold().bg(BG_ELEVATED));
            canvas.print(
                area.x + 2,
                y + 1,
                &truncate_cells(&adr.title, area.w.saturating_sub(4) as usize),
                Style::new().fg(PURPLE).bold().bg(BG_ELEVATED),
            );
        }
        return;
    }

    let memory_events: Vec<_> = state
        .dashboard
        .blackboard_events
        .iter()
        .filter(|event| event.agent == "architecture" || event.event_type.eq_ignore_ascii_case("memory"))
        .collect();
    if memory_events.is_empty() {
        if let Some(adr) = state.adrs.entries.get(state.adrs.selected) {
            canvas.print(area.x + 2, y, "ADR activo", Style::new().fg(AMBER_DIM).bold().bg(BG_ELEVATED));
            if y + 1 < area.bottom() {
                canvas.print(
                    area.x + 2,
                    y + 1,
                    &truncate_cells(&adr.title, area.w.saturating_sub(4) as usize),
                    Style::new().fg(PURPLE).bold().bg(BG_ELEVATED),
                );
            }
            if y + 2 < area.bottom() {
                canvas.print(
                    area.x + 2,
                    y + 2,
                    &truncate_cells(&adr.path, area.w.saturating_sub(4) as usize),
                    Style::new().fg(DIM).bg(BG_ELEVATED),
                );
            }
            return;
        }
        canvas.print(area.x + 2, y, "esperando actividad del agente", Style::new().fg(DIM).bg(BG_ELEVATED));
        return;
    }
    let start = memory_events.len().saturating_sub(area.h.saturating_sub(3) as usize);
    for event in memory_events.iter().skip(start) {
        if y >= area.bottom() {
            break;
        }
        let line = format!("[{}] {}", event.event_type.to_ascii_uppercase(), event.content);
        canvas.print(
            area.x + 2,
            y,
            &truncate_cells(&line, area.w.saturating_sub(4) as usize),
            Style::new().fg(SECONDARY).bg(BG_ELEVATED),
        );
        y += 1;
    }
}

fn draw_vertical_rule(canvas: &mut Canvas, x: u16, area: Rect) {
    if x >= area.right() {
        return;
    }
    for y in area.y..area.bottom() {
        canvas.print(x, y, "│", Style::new().fg(AMBER_DIM).bg(BG_PANEL));
    }
}

fn build_plan_pane_lines(state: &AppState, width: usize) -> Vec<StyledLine> {
    let mut lines = Vec::new();

    if !state.thought.chunks.is_empty() {
        lines.push(StyledLine::new("STREAMING", Style::new().fg(AMBER_DIM).bold(), 0));
        for chunk in &state.thought.chunks {
            let display = agent_display_name(&chunk.coordinator);
            let phase = phase_label(&chunk.phase);
            let title = if phase.is_empty() {
                format!("⬡ {}", display)
            } else {
                format!("⬡ {} · {}", display, phase)
            };
            push_wrapped_lines(
                &mut lines,
                &title,
                width,
                Style::new().fg(worker_color(&chunk.coordinator)).bold(),
                0,
            );

            let content = clean_thought_content(&chunk.content);
            if !content.is_empty() {
                for paragraph in content.lines() {
                    let paragraph = paragraph.trim();
                    if paragraph.is_empty() {
                        continue;
                    }
                    let style = if chunk.phase.contains("think") || chunk.phase.contains("reason") {
                        Style::new().fg(DIM).dim()
                    } else {
                        Style::new().fg(SECONDARY)
                    };
                    push_wrapped_lines(
                        &mut lines,
                        paragraph,
                        width.saturating_sub(2),
                        style,
                        2,
                    );
                }
            }
            lines.push(blank_plan_line());
        }
    }

    if state.plan.current.is_some() {
        if !lines.is_empty() {
            lines.push(StyledLine::new("PLAN FORMAL · FASES Y APROBACIÓN", Style::new().fg(AMBER_DIM).bold(), 0));
        }
        lines.extend(build_plan_lines(state, width));
    } else if !state.filemap.entries.is_empty() {
        if !lines.is_empty() {
            lines.push(blank_plan_line());
        }
        lines.push(StyledLine::new("MAPA DE ARCHIVOS", Style::new().fg(AMBER_DIM).bold(), 0));
        lines.push(StyledLine::new(
            format!("{} archivos reportados por IPC", state.filemap.entries.len()),
            Style::new().fg(DIM),
            1,
        ));
        for entry in &state.filemap.entries {
            let risk = match entry.risk {
                RiskLevel::Low => "LOW",
                RiskLevel::Medium => "MEDIUM",
                RiskLevel::High => "HIGH",
                RiskLevel::Critical => "CRITICAL",
            };
            let operation = if entry.operation.is_empty() {
                String::new()
            } else {
                format!(" · {}", entry.operation)
            };
            push_wrapped_lines(
                &mut lines,
                &format!("[{risk}] {}{operation}", entry.path),
                width,
                Style::new().fg(SECONDARY),
                0,
            );
        }
    }

    lines
}

fn clean_thought_content(content: &str) -> String {
    content
        .replace("<think>", "")
        .replace("</think>", "")
        .trim()
        .to_string()
}

fn phase_label(phase: &str) -> String {
    let phase = phase.trim();
    if phase.is_empty() {
        return String::new();
    }
    match phase {
        "think" | "thinking" | "reason" | "reasoning" => "pensando".to_string(),
        "decide" | "decision" => "decisión".to_string(),
        "assign" | "assignment" => "asignando".to_string(),
        "plan" | "planning" => "plan".to_string(),
        _ => phase.replace('_', " "),
    }
}

fn build_plan_lines(state: &AppState, width: usize) -> Vec<StyledLine> {
    let Some(plan) = state.plan.current.as_ref() else {
        return Vec::new();
    };
    let mut lines = Vec::new();

    push_wrapped_lines(
        &mut lines,
        &format!("ADR: {}", plan.adr_title),
        width,
        Style::new().fg(PURPLE).bold(),
        0,
    );
    let status_color = match plan.status.as_str() {
        "approved" => GREEN,
        "rejected" => RED,
        _ => YELLOW,
    };
    push_wrapped_lines(
        &mut lines,
        &format!("Estado: {}", plan.status.to_uppercase()),
        width,
        Style::new().fg(status_color).bold(),
        0,
    );

    lines.push(blank_plan_line());
    lines.push(StyledLine::new("DETALLE ADR", Style::new().fg(AMBER_DIM).bold(), 0));
    for paragraph in plan.adr_content.split("\n\n") {
        let text = paragraph.trim();
        if !text.is_empty() {
            push_wrapped_lines(&mut lines, text, width, Style::new().fg(SECONDARY), 1);
            lines.push(blank_plan_line());
        }
    }

    lines.push(StyledLine::new("FASES", Style::new().fg(AMBER_DIM).bold(), 0));
    for (idx, phase) in plan.phases.iter().enumerate() {
        let status = format!("[{}]", phase.status.to_uppercase());
        push_wrapped_lines(
            &mut lines,
            &format!(
                "{}. {} · {} {}",
                idx + 1,
                agent_display_name(&phase.coordinator),
                phase.name,
                status
            ),
            width,
            Style::new().fg(worker_color(&phase.coordinator)).bold(),
            0,
        );
        if !phase.description.is_empty() {
            push_wrapped_lines(&mut lines, &phase.description, width.saturating_sub(2), Style::new().fg(SECONDARY), 2);
        }
        if !phase.depends_on.is_empty() {
            push_wrapped_lines(
                &mut lines,
                &format!("depende de: {}", phase.depends_on.join(", ")),
                width.saturating_sub(2),
                Style::new().fg(DIM),
                2,
            );
        }
        lines.push(blank_plan_line());
    }

    lines.push(StyledLine::new("ÁRBOL DE DEPENDENCIAS", Style::new().fg(AMBER_DIM).bold(), 0));
    if plan.phases.is_empty() {
        push_wrapped_lines(&mut lines, "sin dependencias definidas", width, Style::new().fg(DIM), 1);
    } else {
        for phase in &plan.phases {
            render_dependency_line(&mut lines, phase, width);
        }
    }
    lines.push(blank_plan_line());

    lines.push(StyledLine::new("CONTRATOS API", Style::new().fg(AMBER_DIM).bold(), 0));
    if plan.api_contracts.is_empty() {
        push_wrapped_lines(&mut lines, "sin contratos definidos todavía", width, Style::new().fg(DIM), 1);
    } else {
        for contract in &plan.api_contracts {
            render_api_contract_lines(&mut lines, contract, width);
            lines.push(blank_plan_line());
        }
    }

    lines.push(StyledLine::new("RIESGOS", Style::new().fg(AMBER_DIM).bold(), 0));
    if plan.risks.is_empty() {
        push_wrapped_lines(&mut lines, "sin riesgos reportados", width, Style::new().fg(DIM), 1);
    }
    for risk in &plan.risks {
        let risk_color = match risk.severity.as_str() {
            "HIGH" | "high" | "CRITICAL" | "critical" => RED,
            "MEDIUM" | "medium" => YELLOW,
            _ => GREEN,
        };
        push_wrapped_lines(
            &mut lines,
            &format!("[{}] {}", risk.severity.to_uppercase(), risk.description),
            width,
            Style::new().fg(risk_color),
            0,
        );
    }

    lines.push(blank_plan_line());
    lines.push(StyledLine::new("MAPA DE ARCHIVOS", Style::new().fg(AMBER_DIM).bold(), 0));
    if state.filemap.entries.is_empty() {
        push_wrapped_lines(&mut lines, "sin archivos reportados", width, Style::new().fg(DIM), 1);
    }
    for entry in &state.filemap.entries {
        let risk = match entry.risk {
            RiskLevel::Low => "LOW",
            RiskLevel::Medium => "MEDIUM",
            RiskLevel::High => "HIGH",
            RiskLevel::Critical => "CRITICAL",
        };
        let operation = if entry.operation.is_empty() {
            String::new()
        } else {
            format!(" · {}", entry.operation)
        };
        push_wrapped_lines(
            &mut lines,
            &format!("[{risk}] {}{operation}", entry.path),
            width,
            Style::new().fg(SECONDARY),
            0,
        );
    }
    lines
}

fn render_dependency_line(lines: &mut Vec<StyledLine>, phase: &PlanPhase, width: usize) {
    let level_prefix = if phase.level == 0 {
        "root".to_string()
    } else {
        format!("L{}", phase.level)
    };
    let deps = if phase.depends_on.is_empty() {
        "sin dependencias".to_string()
    } else {
        phase.depends_on.join(" <- ")
    };
    push_wrapped_lines(
        lines,
        &format!(
            "{} {} · {} <- {}",
            level_prefix,
            agent_display_name(&phase.coordinator),
            phase.name,
            deps
        ),
        width,
        Style::new().fg(worker_color(&phase.coordinator)),
        1,
    );
}

fn render_api_contract_lines(lines: &mut Vec<StyledLine>, contract: &ApiContract, width: usize) {
    let method = if contract.method.trim().is_empty() {
        "METHOD"
    } else {
        contract.method.as_str()
    };
    let path = if contract.path.trim().is_empty() {
        "path pendiente"
    } else {
        contract.path.as_str()
    };
    let owner = if contract.owner.trim().is_empty() {
        "owner pendiente"
    } else {
        contract.owner.as_str()
    };
    let status = if contract.status.trim().is_empty() {
        "draft"
    } else {
        contract.status.as_str()
    };
    push_wrapped_lines(
        lines,
        &format!("[{}] {} {} · {} · {}", status.to_uppercase(), method, path, contract.name, owner),
        width,
        Style::new().fg(AMBER_BRIGHT).bold(),
        1,
    );
    if !contract.request.trim().is_empty() {
        push_wrapped_lines(
            lines,
            &format!("request: {}", contract.request),
            width.saturating_sub(3),
            Style::new().fg(SECONDARY),
            3,
        );
    }
    if !contract.response.trim().is_empty() {
        push_wrapped_lines(
            lines,
            &format!("response: {}", contract.response),
            width.saturating_sub(3),
            Style::new().fg(SECONDARY),
            3,
        );
    }
}

fn blank_plan_line() -> StyledLine {
    StyledLine::blank(Style::new().fg(SECONDARY))
}

fn wrap_plain(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let extra = usize::from(!current.is_empty());
        if current.len() + word.len() + extra > width && !current.is_empty() {
            lines.push(current);
            current = String::new();
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(word);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{FileEntry, PlanEntry, PlanPhase, PlanRisk, ThoughtChunk};
    use crate::widgets::components::text_width;

    #[test]
    fn plan_scroll_exposes_review_details_and_scrollbar() {
        let mut state = AppState::default();
        state.plan.current = Some(PlanEntry {
            task_id: "task-1".to_string(),
            adr_title: "Mantener limites del layout".to_string(),
            adr_content: (0..10)
                .map(|idx| format!("Contexto detallado {idx} para revisar la decision."))
                .collect::<Vec<_>>()
                .join("\n\n"),
            status: "pending".to_string(),
            phases: vec![PlanPhase {
                name: "Render".to_string(),
                coordinator: "frontend".to_string(),
                description: "Ajustar paneles y controles.".to_string(),
                depends_on: Vec::new(),
                level: 0,
                status: "pending".to_string(),
            }],
            risks: vec![PlanRisk {
                severity: "HIGH".to_string(),
                description: "FINAL_RISK_REVIEW".to_string(),
            }],
            api_contracts: Vec::new(),
        });
        state.plan.scroll = usize::MAX;

        let mut canvas = Canvas::new(96, 22);
        render(&mut canvas, Rect::new(0, 0, 96, 22), &state);
        let rows = canvas.to_text_rows();

        assert!(rows.iter().any(|row| row.contains("FINAL_RISK_REVIEW")));
        assert!(rows.iter().any(|row| row.contains('█')));
    }

    #[test]
    fn plan_wrapping_respects_terminal_cell_width() {
        let mut lines = Vec::new();
        push_wrapped_lines(&mut lines, "abc🐝Z", 4, Style::new(), 0);

        assert!(lines.iter().all(|line| text_width(&line.text) <= 4));
        assert!(lines.iter().any(|line| line.text.contains('Z')));
    }

    #[test]
    fn plan_renders_reasoning_stream_when_plan_is_still_forming() {
        let mut state = AppState::default();
        state.thought.chunks.push(ThoughtChunk {
            coordinator: "bee".to_string(),
            phase: "reasoning".to_string(),
            content: "Voy a desglosar el ticket en capas y validar refresh-token.".to_string(),
        });

        let mut canvas = Canvas::new(100, 20);
        render(&mut canvas, Rect::new(0, 0, 100, 20), &state);
        let rows = canvas.to_text_rows();

        assert!(rows.iter().any(|row| row.contains("ACTIVIDAD")));
        assert!(rows.iter().any(|row| row.contains("Bee")));
        assert!(rows.iter().any(|row| row.contains("refresh-token")));
    }

    #[test]
    fn plan_filemap_scroll_exposes_late_files_and_scrollbar() {
        let mut state = AppState::default();
        state.filemap.entries = (0..18)
            .map(|idx| FileEntry {
                path: format!("src/auth/file_{idx}.ts"),
                risk: if idx % 3 == 0 { RiskLevel::High } else { RiskLevel::Low },
                operation: format!("+{}", idx + 1),
                agent: "backend".to_string(),
                adr_ref: None,
                lines_added: idx + 1,
                lines_removed: 0,
            })
            .collect();
        state.filemap.scroll = usize::MAX;

        let mut canvas = Canvas::new(100, 22);
        render(&mut canvas, Rect::new(0, 0, 100, 22), &state);
        let rows = canvas.to_text_rows();

        assert!(rows.iter().any(|row| row.contains("file_17.ts")));
        assert!(rows.iter().any(|row| row.contains('█')));
    }
}
