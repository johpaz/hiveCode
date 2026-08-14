use crate::{
    state::{AppState, ModalState, ReplMode, RiskLevel},
    term::{
        Canvas, Color, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, BG_PANEL, DIM,
        GREEN, RED, SECONDARY, WHITE, YELLOW,
    },
    ui::{
        build_markdown_lines, render_data_table, render_markdown, render_split_handles,
        split_panes, truncate_cells, Axis, Constraint, DataTable, MarkdownView, SplitPane,
        TableAlign, TableCell, TableColumn, TableState,
    },
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if area.h < 6 || area.w < 40 {
        return;
    }

    if state.review.verdict.is_some() {
        render_verdict_review(canvas, area, state);
        return;
    }

    if area.w < 90 {
        render_stacked(canvas, area, state);
        return;
    }

    let split = SplitPane::new(
        Axis::Horizontal,
        vec![
            Constraint::Percent(state.panels.review_main_percent),
            Constraint::Fill(1),
        ],
    );
    let (cols, handles) = split_panes(area, &split);

    canvas.with_clip(cols[0], |canvas| render_review_main_pane(canvas, cols[0], state));
    render_split_handles(canvas, &handles, Axis::Horizontal);
    canvas.with_clip(cols[1], |canvas| render_review_sidebar(canvas, cols[1], state));
}

fn render_verdict_review(canvas: &mut Canvas, area: Rect, state: &AppState) {
    let top_h = (area.h * 20 / 100).clamp(3, area.h.saturating_sub(3));
    let bottom_h = (area.h * 20 / 100).clamp(3, area.h.saturating_sub(top_h));
    let center_h = area.h.saturating_sub(top_h + bottom_h);
    let top = Rect::new(area.x, area.y, area.w, top_h);
    let center = Rect::new(area.x, area.y + top_h, area.w, center_h);
    let bottom = Rect::new(area.x, area.bottom().saturating_sub(bottom_h), area.w, bottom_h);

    canvas.with_clip(top, |canvas| render_verdict_banner(canvas, top, state));
    canvas.with_clip(center, |canvas| render_review_detail_center(canvas, center, state));
    canvas.with_clip(bottom, |canvas| render_decision_panel(canvas, bottom, state));
}

fn render_verdict_banner(canvas: &mut Canvas, area: Rect, state: &AppState) {
    let Some(verdict) = state.review.verdict.as_ref() else {
        return;
    };
    let bg = review_status_bg(&verdict.status);
    canvas.fill_rect(area, ' ', Style::new().bg(bg));

    let status = review_status_label(&verdict.status);
    let x = area.x + area.w.saturating_sub(status.chars().count() as u16) / 2;
    let y = area.y + area.h / 2;
    canvas.print(x, y, status, Style::new().fg(WHITE).bold().bg(bg));

    let elapsed = state
        .dashboard
        .metrics
        .elapsed_secs
        .map(|seconds| format!("{:02}:{:02}", seconds / 60, seconds % 60))
        .unwrap_or_else(|| "--:--".to_string());
    canvas.print(area.x + 1, area.y, &format!("tiempo total {elapsed}"), Style::new().fg(SECONDARY).bg(bg));

    let model = if state.session.model.is_empty() { "modelo reviewer" } else { state.session.model.as_str() };
    let right = truncate_cells(model, area.w.saturating_sub(2) as usize);
    let right_x = area.right().saturating_sub(right.chars().count() as u16 + 1);
    if right_x > area.x + 1 {
        canvas.print(right_x, area.y, &right, Style::new().fg(SECONDARY).bg(bg));
    }
}

fn render_review_detail_center(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h == 0 {
        return;
    }
    let split = SplitPane::new(
        Axis::Horizontal,
        vec![Constraint::Percent(50), Constraint::Fill(1)],
    );
    let (cols, handles) = split_panes(area, &split);
    let has_criteria = state.review.verdict.as_ref().is_some_and(|v| !v.criteria.is_empty());
    if has_criteria {
        canvas.with_clip(cols[0], |canvas| render_criteria_checklist(canvas, cols[0], state));
    } else {
        canvas.with_clip(cols[0], |canvas| render_observation_categories(canvas, cols[0], state));
    }
    render_split_handles(canvas, &handles, Axis::Horizontal);
    canvas.with_clip(cols[1], |canvas| render_review_diff(canvas, cols[1], state));
}

/// Real pass/fail checklist from `submit_review_verdict` — one row per PRD
/// acceptance criterion, cross-checked against actual evidence (not the
/// keyword-matched heuristic below, which is only a fallback for reviewer
/// models that didn't call the structured tool).
fn render_criteria_checklist(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    let Some(verdict) = state.review.verdict.as_ref() else {
        return;
    };
    let met = verdict.criteria.iter().filter(|c| c.met).count();
    let title = format!("⬡ CRITERIOS DE ACEPTACIÓN · {met}/{}", verdict.criteria.len());
    canvas.print(area.x + 1, area.y, &truncate_cells(&title, area.w.saturating_sub(2) as usize), Style::new().fg(AMBER).bold().bg(BG_PANEL));

    let mut y = area.y + 2;
    for criterion in &verdict.criteria {
        if y >= area.bottom() {
            break;
        }
        let (marker, color) = if criterion.met { ("✓", GREEN) } else { ("✗", RED) };
        canvas.print(area.x + 2, y, marker, Style::new().fg(color).bold().bg(BG_PANEL));
        canvas.print(
            area.x + 4,
            y,
            &truncate_cells(&criterion.description, area.w.saturating_sub(6) as usize),
            Style::new().fg(WHITE).bg(BG_PANEL),
        );
        y += 1;
        if let Some(evidence) = &criterion.evidence {
            if y < area.bottom() {
                canvas.print(
                    area.x + 5,
                    y,
                    &truncate_cells(evidence, area.w.saturating_sub(7) as usize),
                    Style::new().fg(SECONDARY).bg(BG_PANEL),
                );
                y += 1;
            }
        }
        if y < area.bottom() {
            y += 1;
        }
    }
}

fn render_observation_categories(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    canvas.print(area.x + 1, area.y, "⬡ OBSERVACIONES", Style::new().fg(AMBER).bold().bg(BG_PANEL));
    let Some(verdict) = state.review.verdict.as_ref() else {
        return;
    };

    let categories = [
        ("ADRs", observations_matching(&verdict.observations, &["adr", "decision"])),
        ("Workers", observations_matching(&verdict.observations, &["worker", "consisten", "contrato"])),
        ("Código", observations_matching(&verdict.observations, &["lint", "código", "codigo", "antipatr"])),
        ("Security", observations_matching(&verdict.observations, &["security", "seguridad", "vulner"])),
        ("QA", observations_matching(&verdict.observations, &["test", "coverage", "cobertura"])),
    ];
    let mut y = area.y + 2;
    for (label, observations) in categories {
        if y >= area.bottom() {
            break;
        }
        let color = category_color(verdict.status.as_str(), observations.len());
        let marker = if observations.is_empty() { "✓" } else { "!" };
        canvas.print(area.x + 2, y, marker, Style::new().fg(color).bold().bg(BG_PANEL));
        canvas.print(area.x + 4, y, label, Style::new().fg(color).bold().bg(BG_PANEL));
        y += 1;
        let shown = if observations.is_empty() {
            vec!["sin problemas reportados".to_string()]
        } else {
            observations
        };
        for observation in shown.into_iter().take(2) {
            if y >= area.bottom() {
                break;
            }
            canvas.print(
                area.x + 4,
                y,
                &truncate_cells(&observation, area.w.saturating_sub(6) as usize),
                Style::new().fg(SECONDARY).bg(BG_PANEL),
            );
            y += 1;
        }
        if y < area.bottom() {
            y += 1;
        }
    }
}

fn render_review_diff(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    let path = state
        .review
        .verdict
        .as_ref()
        .and_then(|verdict| verdict.affected_files.first())
        .map(String::as_str)
        .or_else(|| (!state.diff.path.is_empty()).then_some(state.diff.path.as_str()))
        .unwrap_or("diff relevante");
    canvas.print(
        area.x + 1,
        area.y,
        &truncate_cells(&format!("⬡ DIFF · {path}"), area.w.saturating_sub(2) as usize),
        Style::new().fg(AMBER_BRIGHT).bold().bg(BG_ELEVATED),
    );
    if state.diff.lines.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "sin diff seleccionado por Reviewer", Style::new().fg(DIM).bg(BG_ELEVATED));
        return;
    }

    let mut y = area.y + 2;
    for line in state.diff.lines.iter().skip(state.diff.scroll).take(area.h.saturating_sub(3) as usize) {
        if y >= area.bottom() {
            break;
        }
        let (prefix, color, bg) = match line.kind.as_str() {
            "add" => ("+", GREEN, Color::Rgb { r: 10, g: 30, b: 15 }),
            "remove" => ("-", RED, Color::Rgb { r: 30, g: 10, b: 10 }),
            _ => (" ", DIM, BG_ELEVATED),
        };
        canvas.fill_rect(Rect::new(area.x + 1, y, area.w.saturating_sub(2), 1), ' ', Style::new().bg(bg));
        canvas.print(area.x + 2, y, prefix, Style::new().fg(color).bold().bg(bg));
        canvas.print(area.x + 4, y, &truncate_cells(&line.text, area.w.saturating_sub(6) as usize), Style::new().fg(WHITE).bg(bg));
        y += 1;
    }
}

fn render_stacked(canvas: &mut Canvas, area: Rect, state: &AppState) {
    let decision_h = if state.session.mode == ReplMode::Approval {
        8
    } else {
        6
    };
    let decision_h = decision_h.min(area.h.saturating_sub(4));
    let split = SplitPane::new(
        Axis::Vertical,
        vec![Constraint::Fill(1), Constraint::Fixed(decision_h)],
    );
    let (rows, handles) = split_panes(area, &split);

    canvas.with_clip(rows[0], |canvas| render_review_main_pane(canvas, rows[0], state));
    render_split_handles(canvas, &handles, Axis::Vertical);
    canvas.with_clip(rows[1], |canvas| render_decision_panel(canvas, rows[1], state));
}

fn render_review_main_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if state.review.verdict.is_some() {
        render_verdict_pane(canvas, area, state);
    } else {
        render_adr_pane(canvas, area, state);
    }
}

fn render_verdict_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    let Some(verdict) = state.review.verdict.as_ref() else {
        return;
    };

    let status_color = review_status_color(&verdict.status);
    let title = truncate_cells(
        &format!("⬡ VEREDICTO · {}", verdict.reviewer),
        area.w.saturating_sub(4) as usize,
    );
    canvas.print(area.x + 1, area.y, &title, Style::new().fg(AMBER).bold());
    let status = verdict.status.to_uppercase();
    let status_x = area.right().saturating_sub(status.chars().count() as u16 + 1);
    if status_x > area.x + 10 {
        canvas.print(status_x, area.y, &status, Style::new().fg(status_color).bold());
    }

    let mut content = String::new();
    content.push_str("## Resumen\n");
    content.push_str(&verdict.summary);
    if !verdict.criteria.is_empty() {
        content.push_str("\n\n## Criterios de Aceptación\n");
        for criterion in &verdict.criteria {
            let mark = if criterion.met { "x" } else { " " };
            content.push_str(&format!("- [{mark}] {}\n", criterion.description));
        }
    }
    content.push_str("\n\n## Observaciones\n");
    if verdict.observations.is_empty() {
        content.push_str("- Sin observaciones reportadas\n");
    } else {
        for observation in &verdict.observations {
            content.push_str("- ");
            content.push_str(observation);
            content.push('\n');
        }
    }
    content.push_str("\n## Cambios Solicitados\n");
    if verdict.requested_changes.is_empty() {
        content.push_str("- Sin cambios solicitados\n");
    } else {
        for change in &verdict.requested_changes {
            content.push_str("- ");
            content.push_str(change);
            content.push('\n');
        }
    }
    content.push_str("\n## Archivos Afectados\n");
    if verdict.affected_files.is_empty() {
        content.push_str("- Sin archivos reportados por reviewer\n");
    } else {
        for file in &verdict.affected_files {
            content.push_str("- ");
            content.push_str(file);
            content.push('\n');
        }
    }

    let body = Rect::new(area.x + 2, area.y + 2, area.w.saturating_sub(4), area.h.saturating_sub(3));
    render_markdown(
        canvas,
        body,
        &content,
        MarkdownView { scroll: state.adrs.scroll },
    );
}

fn render_review_sidebar(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    if area.h < 10 {
        render_approval_files(canvas, area, state);
        return;
    }

    let split = SplitPane::new(
        Axis::Vertical,
        vec![
            Constraint::Percent(state.panels.review_right_percent),
            Constraint::Fill(1),
        ],
    );
    let (rows, handles) = split_panes(area, &split);

    canvas.with_clip(rows[0], |canvas| render_approval_files(canvas, rows[0], state));
    render_split_handles(canvas, &handles, Axis::Vertical);
    canvas.with_clip(rows[1], |canvas| render_decision_panel(canvas, rows[1], state));
}

fn render_adr_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if state.adrs.entries.is_empty() {
        canvas.print(
            area.x + 1,
            area.y,
            "⬡ ADR · Architecture Decision Records",
            Style::new().fg(AMBER).bold(),
        );
        canvas.print(
            area.x + 2,
            area.y + 2,
            "Sin ADRs activos",
            Style::new().fg(DIM),
        );
        canvas.print(
            area.x + 2,
            area.y + 3,
            "Se mostrarán aquí cuando el worker de arquitectura genere decisiones.",
            Style::new().fg(DIM),
        );
        return;
    }

    let idx = state.adrs.selected.min(state.adrs.entries.len().saturating_sub(1));
    let adr = &state.adrs.entries[idx];
    let status_color = match adr.status.as_str() {
        "accepted" => GREEN,
        "proposed" => YELLOW,
        "rejected" => RED,
        _ => DIM,
    };

    let nav = format!("[{}/{}]", idx + 1, state.adrs.entries.len());
    let right_text = format!("{} {}", adr.status, nav);
    let right_w = right_text.chars().count() as u16;
    let title_w = area.w.saturating_sub(right_w.saturating_add(4)) as usize;
    let title = truncate_cells(&format!("⬡ ADR · {}", adr.title), title_w.max(1));

    canvas.print(area.x + 1, area.y, &title, Style::new().fg(AMBER).bold());
    canvas.print(
        area.right().saturating_sub(right_w + 1),
        area.y,
        &right_text,
        Style::new().fg(status_color).bold(),
    );

    if area.h > 2 {
        let path = if adr.path.is_empty() {
            "path pendiente".to_string()
        } else {
            adr.path.clone()
        };
        let meta = truncate_cells(
            &format!("{} · [/] navegar ADR · ↑↓/rueda scroll", path),
            area.w.saturating_sub(4) as usize,
        );
        canvas.print(area.x + 2, area.y + 1, &meta, Style::new().fg(SECONDARY));
    }

    let body_y = area.y + 3;
    let body_h = area.bottom().saturating_sub(body_y + 1);
    if body_h == 0 {
        return;
    }

    let markdown_area = Rect::new(area.x + 2, body_y, area.w.saturating_sub(4), body_h);
    render_markdown(
        canvas,
        markdown_area,
        &adr.content,
        MarkdownView { scroll: state.adrs.scroll },
    );

    let lines = build_markdown_lines(
        &adr.content,
        markdown_area.w.saturating_sub(2).max(1) as usize,
    );
    let max_scroll = lines.len().saturating_sub(markdown_area.h as usize);
    if max_scroll > 0 {
        let scroll = state.adrs.scroll.min(max_scroll);
        let pct = (scroll * 100) / lines.len().max(1);
        let hint = format!("{}% · PgUp/PgDn · rueda", pct);
        canvas.print(
            area.right().saturating_sub(hint.chars().count() as u16 + 1),
            area.bottom().saturating_sub(1),
            &hint,
            Style::new().fg(DIM),
        );
    }
}

fn render_approval_files(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    let file_count = state.filemap.entries.len();
    let title = if state.session.mode == ReplMode::Approval {
        format!("⬡ ARCHIVOS PARA APROBAR · {file_count}")
    } else {
        format!("⬡ REVISION DE ARCHIVOS · {file_count}")
    };
    let title = truncate_cells(&title, area.w.saturating_sub(2) as usize);
    canvas.print(area.x + 1, area.y, &title, Style::new().fg(AMBER_BRIGHT).bold());

    if state.filemap.entries.is_empty() {
        if area.h > 2 {
            canvas.print(
                area.x + 2,
                area.y + 2,
                "sin archivos pendientes de aprobación",
                Style::new().fg(DIM),
            );
        }
        return;
    }

    let table_h = area.h.saturating_sub(2);
    if table_h == 0 {
        return;
    }

    let columns = [
        TableColumn::fixed("", 1, TableAlign::Left),
        TableColumn::fill("archivo", 1, TableAlign::Left),
        TableColumn::fixed("cambio", 9, TableAlign::Right),
        TableColumn::fixed("riesgo", 6, TableAlign::Right),
    ];
    let rows = state
        .filemap
        .entries
        .iter()
        .map(|entry| {
            let (dot_color, risk_tag) = risk_style(entry.risk);
            let path = if let Some(adr_ref) =
                entry.adr_ref.as_ref().filter(|adr_ref| !adr_ref.is_empty())
            {
                format!("{} · {}", entry.path, adr_ref)
            } else {
                entry.path.clone()
            };
            vec![
                TableCell::new("●", Style::new().fg(dot_color).bold()),
                TableCell::new(path, Style::new().fg(WHITE)),
                TableCell::new(change_label(entry), Style::new().fg(SECONDARY)),
                TableCell::new(risk_tag, Style::new().fg(dot_color).bold()),
            ]
        })
        .collect::<Vec<_>>();

    render_data_table(
        canvas,
        Rect::new(area.x + 1, area.y + 2, area.w.saturating_sub(2), table_h),
        &columns,
        &rows,
        TableState::default(),
        &DataTable { show_header: true, ..DataTable::default() },
    );
}

fn render_decision_panel(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    if area.h == 0 {
        return;
    }

    canvas.print(
        area.x,
        area.y,
        &"─".repeat(area.w as usize),
        Style::new().fg(AMBER_DIM),
    );

    let is_approval = state.session.mode == ReplMode::Approval;
    let title = if is_approval {
        "⬡ DECISION · APROBAR O RECHAZAR"
    } else {
        "⬡ DECISION · revision preparada"
    };
    canvas.print(
        area.x + 1,
        area.y + 1,
        &truncate_cells(title, area.w.saturating_sub(2) as usize),
        Style::new().fg(AMBER_BRIGHT).bold(),
    );

    if let ModalState::ReviewConfirm(confirm) = &state.modal {
        if area.h > 3 {
            let question = format!("confirmar {} del veredicto", confirm.action.label());
            canvas.print(
                area.x + 2,
                area.y + 3,
                &truncate_cells(&question, area.w.saturating_sub(4) as usize),
                Style::new().fg(AMBER_BRIGHT).bold(),
            );
        }
        if area.h > 5 {
            canvas.print(
                area.x + 2,
                area.y + 5,
                "Enter confirma · Esc cancela",
                Style::new().fg(SECONDARY),
            );
        }
        return;
    }

    let (low, medium, high, critical) = risk_counts(state);
    let (risk_label, risk_color) = highest_risk(low, medium, high, critical);
    if area.h > 3 {
        let summary =
            format!("riesgo max: {risk_label} · low {low} · med {medium} · high {high} · crit {critical}");
        canvas.print(
            area.x + 2,
            area.y + 3,
            &truncate_cells(&summary, area.w.saturating_sub(4) as usize),
            Style::new().fg(risk_color).bold(),
        );
    }

    if area.h > 5 {
        if let Some(cp) = state.checkpoints.entries.last() {
            let tests = if cp.tests_total > 0 {
                format!(" · tests {}/{}", cp.tests_passed, cp.tests_total)
            } else {
                String::new()
            };
            let checkpoint = format!("checkpoint {} · {}{}", cp.time, cp.description, tests);
            canvas.print(
                area.x + 2,
                area.y + 4,
                &truncate_cells(&checkpoint, area.w.saturating_sub(4) as usize),
                Style::new().fg(SECONDARY),
            );
        } else {
            canvas.print(
                area.x + 2,
                area.y + 4,
                "sin checkpoint asociado",
                Style::new().fg(DIM),
            );
        }
    }

    if area.h > 6 && !state.conflicts.entries.is_empty() {
        let conflict = &state.conflicts.entries[0];
        let text = format!(
            "conflicto: {} ↔ {} · {}",
            conflict.agent_a, conflict.agent_b, conflict.path
        );
        canvas.print(
            area.x + 2,
            area.y + 5,
            &truncate_cells(&text, area.w.saturating_sub(4) as usize),
            Style::new().fg(RED).bold(),
        );
    }

    let hint_y = area.bottom().saturating_sub(2);
    if hint_y > area.y + 1 {
        if is_approval {
            render_approval_hints(canvas, area, hint_y);
        } else {
            let hint = "↩ /approve para aceptar · /reject <razón> para devolver";
            canvas.print(
                area.x + 2,
                hint_y,
                &truncate_cells(hint, area.w.saturating_sub(4) as usize),
                Style::new().fg(AMBER),
            );
        }
    }
}

fn render_approval_hints(canvas: &mut Canvas, area: Rect, y: u16) {
    let narrow = area.w < 54;
    if narrow {
        canvas.print(area.x + 2, y, "[a] aprobar", Style::new().fg(GREEN).bold());
        canvas.print(area.x + 2, y + 1, "[r] rechazar  [m] modificar", Style::new().fg(RED).bold());
        return;
    }

    canvas.print(area.x + 2, y, "[a] aprobar", Style::new().fg(GREEN).bold());
    canvas.print(area.x + 15, y, "[r] rechazar", Style::new().fg(RED).bold());
    canvas.print(area.x + 29, y, "[m] modificar", Style::new().fg(YELLOW).bold());
    canvas.print(area.x + 44, y, "requiere Enter de confirmación", Style::new().fg(DIM));
}

fn change_label(entry: &crate::state::FileEntry) -> String {
    if entry.lines_added > 0 || entry.lines_removed > 0 {
        let mut label = String::new();
        if entry.lines_added > 0 {
            label.push_str(&format!("+{}", entry.lines_added));
        }
        if entry.lines_removed > 0 {
            if !label.is_empty() {
                label.push(' ');
            }
            label.push_str(&format!("-{}", entry.lines_removed));
        }
        label
    } else if !entry.operation.is_empty() {
        entry.operation.clone()
    } else if !entry.agent.is_empty() {
        entry.agent.clone()
    } else {
        "-".to_string()
    }
}

fn risk_style(risk: RiskLevel) -> (Color, &'static str) {
    match risk {
        RiskLevel::Low => (GREEN, "low"),
        RiskLevel::Medium => (YELLOW, "med"),
        RiskLevel::High => (AMBER, "high"),
        RiskLevel::Critical => (RED, "crit"),
    }
}

fn risk_counts(state: &AppState) -> (usize, usize, usize, usize) {
    let mut low = 0;
    let mut medium = 0;
    let mut high = 0;
    let mut critical = 0;

    for entry in &state.filemap.entries {
        match entry.risk {
            RiskLevel::Low => low += 1,
            RiskLevel::Medium => medium += 1,
            RiskLevel::High => high += 1,
            RiskLevel::Critical => critical += 1,
        }
    }

    (low, medium, high, critical)
}

fn highest_risk(low: usize, medium: usize, high: usize, critical: usize) -> (&'static str, Color) {
    if critical > 0 {
        ("CRITICAL", RED)
    } else if high > 0 {
        ("HIGH", AMBER)
    } else if medium > 0 {
        ("MEDIUM", YELLOW)
    } else if low > 0 {
        ("LOW", GREEN)
    } else {
        ("NONE", DIM)
    }
}

fn review_status_color(status: &str) -> Color {
    match status {
        "approved" | "pass" | "passed" | "approval" => GREEN,
        "rejected" | "failed" | "fail" => RED,
        "changes_requested" | "needs_changes" | "modify" => YELLOW,
        _ => AMBER,
    }
}

fn review_status_bg(status: &str) -> Color {
    let normalized = status.to_ascii_lowercase();
    if normalized.contains("reject") || normalized.contains("fail") || normalized.contains("rechaz") {
        Color::Rgb { r: 58, g: 14, b: 18 }
    } else if normalized.contains("observ") || normalized.contains("changes") || normalized.contains("modify") {
        Color::Rgb { r: 42, g: 32, b: 8 }
    } else {
        Color::Rgb { r: 8, g: 52, b: 29 }
    }
}

fn review_status_label(status: &str) -> &'static str {
    let normalized = status.to_ascii_lowercase();
    if normalized.contains("reject") || normalized.contains("fail") || normalized.contains("rechaz") {
        "RECHAZADO"
    } else if normalized.contains("observ") || normalized.contains("changes") || normalized.contains("modify") {
        "APROBADO CON OBSERVACIONES"
    } else {
        "APROBADO"
    }
}

fn observations_matching(observations: &[String], needles: &[&str]) -> Vec<String> {
    observations
        .iter()
        .filter(|observation| {
            let lower = observation.to_ascii_lowercase();
            needles.iter().any(|needle| lower.contains(needle))
        })
        .cloned()
        .collect()
}

fn category_color(status: &str, count: usize) -> Color {
    if count == 0 {
        return GREEN;
    }
    let status = status.to_ascii_lowercase();
    if status.contains("reject") || status.contains("fail") || status.contains("rechaz") {
        RED
    } else {
        YELLOW
    }
}
