use crate::{
    state::{AppState, RiskLevel},
    term::{Canvas, Rect, Style, AMBER, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM, GREEN, PURPLE, RED, SECONDARY, WHITE, YELLOW},
};
use unicode_width::UnicodeWidthChar;

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if area.w < 40 {
        return;
    }

    // 60/40 split: left = plan, right = filemap + ADR extract
    let left_w = area.w * 60 / 100;
    let cols = area.hsplit(&[left_w, 0]);
    let left = cols[0];
    let right = cols[1];

    canvas.with_clip(left, |canvas| render_plan_pane(canvas, left, state));

    // Right panel: vertical split — filemap top (~65%), ADR extract bottom (~35%)
    let filemap_h = right.h * 65 / 100;
    let right_rows = right.vsplit(&[filemap_h, 0]);
    canvas.with_clip(right_rows[0], |canvas| render_filemap_tree(canvas, right_rows[0], state));
    canvas.with_clip(right_rows[1], |canvas| render_adr_extract(canvas, right_rows[1], state));
}

// ── Left panel: structured plan view ──────────────────────────────────────────

fn render_plan_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    let title = "⬡ PLAN · fases y aprobación";
    canvas.print(area.x + 1, area.y, title, Style::new().fg(AMBER).bold());

    if state.plan.current.is_none() {
        canvas.print(area.x + 2, area.y + 2, "No hay plan activo.", Style::new().fg(DIM));
        canvas.print(area.x + 2, area.y + 3, "Envía una tarea en modo PLAN para generar uno.", Style::new().fg(DIM));
        return;
    }

    let content_w = area.w.saturating_sub(4).max(1) as usize;
    let lines = build_plan_lines(state, content_w);
    let body_y = area.y + 2;
    let body_h = area.bottom().saturating_sub(body_y + 1) as usize;
    if body_h == 0 {
        return;
    }
    let max_scroll = lines.len().saturating_sub(body_h);
    let scroll = state.plan.scroll.min(max_scroll);

    for (offset, line) in lines.iter().skip(scroll).take(body_h).enumerate() {
        canvas.print(
            area.x + 1 + line.indent,
            body_y + offset as u16,
            &line.text,
            line.style,
        );
    }

    if max_scroll > 0 {
        render_plan_scrollbar(
            canvas,
            Rect::new(area.right().saturating_sub(1), body_y, 1, body_h as u16),
            lines.len(),
            scroll,
        );
        canvas.print(
            area.x + 1,
            area.bottom().saturating_sub(1),
            "PgUp/PgDn · rueda",
            Style::new().fg(DIM),
        );
    }
}

// ── Right panel top: filemap tree ─────────────────────────────────────────────

fn render_filemap_tree(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    let title = "⬡ MAPA DE ARCHIVOS · riesgo";
    canvas.print(area.x + 1, area.y, title, Style::new().fg(AMBER).bold());

    let entries = &state.filemap.entries;
    if entries.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "sin archivos modificados", Style::new().fg(DIM));
        return;
    }

    let mut y = area.y + 1;
    let max_y = area.bottom().saturating_sub(1);
    let content_w = area.w.saturating_sub(4) as usize;

    let mut dirs: std::collections::BTreeMap<String, Vec<&crate::state::FileEntry>> = std::collections::BTreeMap::new();
    for entry in entries.iter() {
        let dir = if let Some(pos) = entry.path.rfind('/') {
            entry.path[..pos + 1].to_string()
        } else {
            "".to_string()
        };
        dirs.entry(dir).or_default().push(entry);
    }

    for (dir, files) in dirs {
        if y >= max_y { break; }

        if !dir.is_empty() {
            let folder_label = format!("▸ {}", dir.trim_end_matches('/'));
            let shown: String = folder_label.chars().take(content_w).collect();
            canvas.print(area.x + 1, y, &shown, Style::new().fg(AMBER_DIM).bold());
            y += 1;
        }

        for entry in files {
            if y >= max_y { break; }

            let (dot_color, _risk_tag) = match entry.risk {
                RiskLevel::Low      => (GREEN,  "low "),
                RiskLevel::Medium   => (YELLOW, "med "),
                RiskLevel::High     => (AMBER,  "high"),
                RiskLevel::Critical => (RED,    "crit"),
            };

            let file_name = if let Some(pos) = entry.path.rfind('/') {
                &entry.path[pos + 1..]
            } else {
                &entry.path
            };

            let indent = if dir.is_empty() { 1 } else { 3 };
            let x = area.x + indent as u16;

            canvas.print(x, y, "●", Style::new().fg(dot_color).bold());
            let name_shown: String = file_name.chars().take(content_w.saturating_sub(indent + 1)).collect();
            canvas.print(x + 2, y, &name_shown, Style::new().fg(WHITE));

            let mut right_parts = Vec::new();
            if !entry.operation.is_empty() {
                right_parts.push(entry.operation.clone());
            } else if entry.lines_added > 0 || entry.lines_removed > 0 {
                let mut op = String::new();
                if entry.lines_added > 0 {
                    op.push_str(&format!("+{}", entry.lines_added));
                }
                if entry.lines_removed > 0 {
                    if !op.is_empty() { op.push(' '); }
                    op.push_str(&format!("-{}", entry.lines_removed));
                }
                right_parts.push(op);
            }

            if !right_parts.is_empty() {
                let right_text = right_parts.join(" ");
                let rtx = area.right().saturating_sub(right_text.chars().count() as u16 + 1);
                if rtx > x + 2 + name_shown.len() as u16 {
                    canvas.print(rtx, y, &right_text, Style::new().fg(DIM));
                }
            }

            if let Some(ref adr) = entry.adr_ref {
                if y + 1 < max_y {
                    let adr_text = format!("bloqueado por {}", adr);
                    let adr_shown: String = adr_text.chars().take(content_w.saturating_sub(indent + 2)).collect();
                    canvas.print(x + 2, y + 1, &adr_shown, Style::new().fg(RED).dim());
                    y += 1;
                }
            }

            y += 1;
        }
    }
}

// ── Right panel bottom: ADR extract ───────────────────────────────────────────

fn render_adr_extract(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    let border: String = std::iter::repeat('─').take(area.w as usize).collect();
    canvas.print(area.x, area.y, &border, Style::new().fg(AMBER_DIM));

    // Prefer ADR from active plan if available
    let plan_adr = state.plan.current.as_ref()
        .filter(|p| !p.adr_title.is_empty())
        .map(|p| (p.adr_title.clone(), p.adr_content.clone()));

    let (title_text, content_text) = if let Some((t, c)) = plan_adr {
        (t, c)
    } else if let Some(adr) = state.adrs.entries.get(state.adrs.selected) {
        (adr.title.clone(), adr.content.clone())
    } else {
        canvas.print(area.x + 1, area.y + 1, "⬡ ADRs · consultados por Bee", Style::new().fg(PURPLE).bold());
        canvas.print(area.x + 2, area.y + 3, "sin ADRs — Bee analizando...", Style::new().fg(DIM));
        return;
    };

    let title = format!("⬡ {} - extracto", title_text);
    canvas.print(area.x + 1, area.y + 1, &title, Style::new().fg(PURPLE).bold());

    let content_w = area.w.saturating_sub(4) as usize;
    let mut y = area.y + 3;
    let max_y = area.bottom().saturating_sub(1);

    for paragraph in content_text.split("\n\n") {
        if y >= max_y { break; }
        let trimmed = paragraph.trim();
        if trimmed.is_empty() { continue; }

        let mut line = String::new();
        for word in trimmed.split_whitespace() {
            if line.len() + word.len() + 1 > content_w {
                if y >= max_y { break; }
                canvas.print(area.x + 2, y, &line, Style::new().fg(SECONDARY));
                y += 1;
                line.clear();
                line.push_str(word);
            } else {
                if !line.is_empty() { line.push(' '); }
                line.push_str(word);
            }
        }
        if !line.is_empty() && y < max_y {
            canvas.print(area.x + 2, y, &line, Style::new().fg(SECONDARY));
            y += 1;
        }
        y += 1;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn agent_display_name(name: &str) -> String {
    match name {
        "bee" => "Bee".to_string(),
        "architecture" => "Architecture".to_string(),
        "backend" => "BackendEngineer".to_string(),
        "frontend" => "FrontendEngineer".to_string(),
        "security" => "SecurityAuditor".to_string(),
        "test" => "QAEngineer".to_string(),
        "devops" => "DevOpsEngineer".to_string(),
        "product_manager" => "ProductManager".to_string(),
        "mobile" => "MobileEngineer".to_string(),
        "data_scientist" => "DataScientist".to_string(),
        "dba" => "DBA".to_string(),
        "integration" => "IntegrationEngineer".to_string(),
        "reviewer" => "Reviewer".to_string(),
        _ => {
            let mut s = name.to_string();
            if let Some(first) = s.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            s
        }
    }
}

fn worker_color(name: &str) -> crate::term::Color {
    use crate::term::{AMBER_BRIGHT, BLUE, CYAN, LAVENDER, PINK, PURPLE, YELLOW};
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

#[derive(Clone)]
struct PlanLine {
    text: String,
    style: Style,
    indent: u16,
}

fn build_plan_lines(state: &AppState, width: usize) -> Vec<PlanLine> {
    let Some(plan) = state.plan.current.as_ref() else {
        return Vec::new();
    };
    let mut lines = Vec::new();

    push_plan_wrapped(
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
    push_plan_wrapped(
        &mut lines,
        &format!("Estado: {}", plan.status.to_uppercase()),
        width,
        Style::new().fg(status_color).bold(),
        0,
    );

    lines.push(blank_plan_line());
    lines.push(PlanLine {
        text: "DETALLE ADR".to_string(),
        style: Style::new().fg(AMBER_DIM).bold(),
        indent: 0,
    });
    for paragraph in plan.adr_content.split("\n\n") {
        let text = paragraph.trim();
        if !text.is_empty() {
            push_plan_wrapped(&mut lines, text, width, Style::new().fg(SECONDARY), 1);
            lines.push(blank_plan_line());
        }
    }

    lines.push(PlanLine {
        text: "FASES".to_string(),
        style: Style::new().fg(AMBER_DIM).bold(),
        indent: 0,
    });
    for (idx, phase) in plan.phases.iter().enumerate() {
        let status = format!("[{}]", phase.status.to_uppercase());
        push_plan_wrapped(
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
            push_plan_wrapped(&mut lines, &phase.description, width.saturating_sub(2), Style::new().fg(SECONDARY), 2);
        }
        if !phase.depends_on.is_empty() {
            push_plan_wrapped(
                &mut lines,
                &format!("depende de: {}", phase.depends_on.join(", ")),
                width.saturating_sub(2),
                Style::new().fg(DIM),
                2,
            );
        }
        lines.push(blank_plan_line());
    }

    lines.push(PlanLine {
        text: "RIESGOS".to_string(),
        style: Style::new().fg(AMBER_DIM).bold(),
        indent: 0,
    });
    if plan.risks.is_empty() {
        push_plan_wrapped(&mut lines, "sin riesgos reportados", width, Style::new().fg(DIM), 1);
    }
    for risk in &plan.risks {
        let risk_color = match risk.severity.as_str() {
            "HIGH" | "high" | "CRITICAL" | "critical" => RED,
            "MEDIUM" | "medium" => YELLOW,
            _ => GREEN,
        };
        push_plan_wrapped(
            &mut lines,
            &format!("[{}] {}", risk.severity.to_uppercase(), risk.description),
            width,
            Style::new().fg(risk_color),
            0,
        );
    }

    lines.push(blank_plan_line());
    lines.push(PlanLine {
        text: "MAPA DE ARCHIVOS".to_string(),
        style: Style::new().fg(AMBER_DIM).bold(),
        indent: 0,
    });
    if state.filemap.entries.is_empty() {
        push_plan_wrapped(&mut lines, "sin archivos reportados", width, Style::new().fg(DIM), 1);
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
        push_plan_wrapped(
            &mut lines,
            &format!("[{risk}] {}{operation}", entry.path),
            width,
            Style::new().fg(SECONDARY),
            0,
        );
    }
    lines
}

fn blank_plan_line() -> PlanLine {
    PlanLine {
        text: String::new(),
        style: Style::new().fg(SECONDARY),
        indent: 0,
    }
}

fn push_plan_wrapped(lines: &mut Vec<PlanLine>, text: &str, width: usize, style: Style, indent: u16) {
    let width = width.max(1);
    let mut remaining = text.trim().to_string();
    if remaining.is_empty() {
        lines.push(blank_plan_line());
        return;
    }
    while !remaining.is_empty() {
        let chars: Vec<char> = remaining.chars().collect();
        let mut hard_end = 0usize;
        let mut cells = 0usize;
        while hard_end < chars.len() {
            let char_width = UnicodeWidthChar::width(chars[hard_end]).unwrap_or(1).max(1);
            if hard_end > 0 && cells + char_width > width {
                break;
            }
            cells += char_width;
            hard_end += 1;
        }
        if hard_end == chars.len() {
            lines.push(PlanLine {
                text: remaining,
                style,
                indent,
            });
            break;
        }
        let split = chars[..hard_end]
            .iter()
            .rposition(|ch| ch.is_whitespace())
            .filter(|idx| *idx > 0)
            .unwrap_or(hard_end);
        let text: String = chars[..split].iter().collect();
        lines.push(PlanLine {
            text: text.trim_end().to_string(),
            style,
            indent,
        });
        remaining = chars[split..].iter().collect::<String>().trim_start().to_string();
    }
}

fn render_plan_scrollbar(canvas: &mut Canvas, area: Rect, total: usize, start: usize) {
    if area.h == 0 || total == 0 {
        return;
    }
    let visible = area.h as usize;
    let thumb_h = (visible * visible / total).max(1).min(visible);
    let max_start = total.saturating_sub(visible);
    let thumb_top = if max_start == 0 {
        0
    } else {
        start.min(max_start) * visible.saturating_sub(thumb_h) / max_start
    };
    for row in 0..visible {
        let glyph = if row >= thumb_top && row < thumb_top + thumb_h {
            "█"
        } else {
            "│"
        };
        canvas.print(area.x, area.y + row as u16, glyph, Style::new().fg(DIM));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{PlanEntry, PlanPhase, PlanRisk};
    use unicode_width::UnicodeWidthChar;

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
        push_plan_wrapped(&mut lines, "abc🐝Z", 4, Style::new(), 0);

        assert!(lines.iter().all(|line| {
            line.text
                .chars()
                .map(|ch| UnicodeWidthChar::width(ch).unwrap_or(1))
                .sum::<usize>()
                <= 4
        }));
        assert!(lines.iter().any(|line| line.text.contains('Z')));
    }
}
