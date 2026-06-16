use crate::{
    state::{AgentTier, AppState, WorkerStatus, tier_for},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, BG_PANEL, BLUE, CYAN, DIM, GREEN, PURPLE, RED, SECONDARY, WHITE, YELLOW},
    ui::{cell_width, fmt_tokens, render_split_handles, split_panes, truncate_cells, Axis, Constraint, SplitPane},
    widgets::components::{agent_display_name, worker_color},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if area.w < 40 {
        return;
    }

    let split = SplitPane::new(
        Axis::Horizontal,
        vec![Constraint::Percent(state.panels.code_main_percent), Constraint::Fill(1)],
    );
    let (cols, handles) = split_panes(area, &split);
    canvas.with_clip(cols[0], |canvas| render_diff_pane(canvas, cols[0], state));
    render_split_handles(canvas, &handles, Axis::Horizontal);
    canvas.with_clip(cols[1], |canvas| render_workers_pane(canvas, cols[1], state));
}

// ── Left panel: diff viewer ───────────────────────────────────────────────────

fn render_diff_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));

    if state.diff.lines.is_empty() {
        render_filemap_fallback(canvas, area, state);
        return;
    }

    // Header: path + stats + branch
    let path = &state.diff.path;
    let stats = format!("+{} -{}", state.diff.stats_added, state.diff.stats_removed);
    let branch = if state.diff.branch.is_empty() {
        String::new()
    } else {
        format!(" · branch {}", state.diff.branch)
    };

    let header_left = format!("⬡ {}", path);
    let header_right = format!("{} {}", stats, branch);
    let backend_tag = active_worker_tag(state);
    let backend_w = cell_width(backend_tag) as u16;
    let backend_x = area.right().saturating_sub(backend_w + 1);

    let hl_shown = truncate_cells(&header_left, area.w.saturating_sub(3) as usize);
    canvas.print(area.x + 1, area.y, &hl_shown, Style::new().fg(AMBER).bold());

    if !header_right.is_empty() {
        let right_limit = backend_x.saturating_sub(2);
        let left_limit = area.x + 1 + cell_width(&hl_shown) as u16 + 2;
        let available = right_limit.saturating_sub(left_limit) as usize;
        let header_right = truncate_cells(&header_right, available);
        let hr_x = right_limit.saturating_sub(cell_width(&header_right) as u16);
        if hr_x > area.x + 1 + cell_width(&hl_shown) as u16 {
            canvas.print(hr_x, area.y, &header_right, Style::new().fg(DIM));
        }
    }

    // Backend indicator top-right
    canvas.print(backend_x, area.y, backend_tag, Style::new().fg(BLUE));

    let avail_h = area.h.saturating_sub(3) as usize;
    let start = state.diff.scroll.min(state.diff.lines.len().saturating_sub(avail_h));
    let mut y = area.y + 2;

    // Column widths
    let line_no_w = 6usize;
    let content_x = area.x + line_no_w as u16 + 3;
    let content_w = area.w.saturating_sub(line_no_w as u16 + 4) as usize;

    for dl in state.diff.lines.iter().skip(start).take(avail_h) {
        if y >= area.bottom().saturating_sub(1) { break; }

        let (prefix, prefix_fg, bg) = match dl.kind.as_str() {
            "add"    => ("+", GREEN, Some(Style::new().bg(crate::term::Color::Rgb { r: 10, g: 30, b: 15 }))),
            "remove" => ("-", RED, Some(Style::new().bg(crate::term::Color::Rgb { r: 30, g: 10, b: 10 }))),
            _        => (" ", DIM, None),
        };

        // Line numbers
        let old_no = dl.old_line_no.map(|n| format!("{:>3}", n)).unwrap_or_else(|| "   ".to_string());
        let new_no = dl.new_line_no.map(|n| format!("{:>3}", n)).unwrap_or_else(|| "   ".to_string());
        let line_no_text = format!("{} {}", old_no, new_no);
        canvas.print(area.x + 1, y, &line_no_text, Style::new().fg(DIM));

        // Prefix
        canvas.print(area.x + line_no_w as u16 + 1, y, prefix, Style::new().fg(prefix_fg));

        // Content with syntax highlight
        let text = truncate_cells(&dl.text, content_w);
        render_code_line(canvas, content_x, y, &text, content_w, bg);

        y += 1;
    }

    render_diff_footer(canvas, area, state, start, avail_h);
}

fn render_diff_footer(canvas: &mut Canvas, area: Rect, state: &AppState, start: usize, visible: usize) {
    if area.h < 3 || state.diff.lines.is_empty() {
        return;
    }

    let total = state.diff.lines.len();
    let shown_end = start.saturating_add(visible).min(total);
    let hint = if total > visible {
        let pct = (start * 100) / total.max(1);
        format!("{}% · líneas {}-{} de {} · ↑↓/rueda", pct, start + 1, shown_end, total)
    } else {
        format!("líneas 1-{} de {} · diff completo", shown_end, total)
    };
    let hint = truncate_cells(&hint, area.w.saturating_sub(2) as usize);
    canvas.print(
        area.right().saturating_sub(cell_width(&hint) as u16 + 1),
        area.bottom().saturating_sub(1),
        &hint,
        Style::new().fg(DIM),
    );
}

fn render_filemap_fallback(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.print(area.x + 1, area.y, "⬡ ARCHIVOS MODIFICADOS", Style::new().fg(AMBER).bold());

    let avail_h = area.h.saturating_sub(2) as usize;
    let entries = &state.filemap.entries;

    if entries.is_empty() {
        // Si hay workers activos, mostrar spinner de búsqueda en lugar de mensaje vacío
        let has_active_workers = state.workers.workers.iter().any(|w| w.status == WorkerStatus::Running);
        if has_active_workers || state.running {
            let spinner_frames = &["◐", "◓", "◑", "◒"];
            let spin = spinner_frames[(state.anim_tick as usize) % spinner_frames.len()];
            let coord = if state.workers.active_coordinator.is_empty() {
                "bee"
            } else {
                &state.workers.active_coordinator
            };
            let header = format!("{} {} buscando y analizando código…", spin, coord);
            let truncated_header = truncate_cells(&header, area.w.saturating_sub(4) as usize);
            canvas.print(area.x + 2, area.y + 2, &truncated_header, Style::new().fg(AMBER_BRIGHT));
            if let Some(activity) = state.harness.last_activity.as_deref() {
                let truncated = truncate_cells(activity, area.w.saturating_sub(4) as usize);
                canvas.print(area.x + 2, area.y + 3, &truncated, Style::new().fg(DIM));
            }
        } else {
            canvas.print(area.x + 2, area.y + 2, "sin cambios en curso", Style::new().fg(DIM));
            canvas.print(area.x + 2, area.y + 3,
                "Los diffs aparecerán aquí cuando los workers escriban archivos.",
                Style::new().fg(DIM));
        }
        return;
    }

    let start = entries.len().saturating_sub(avail_h);
    let mut y = area.y + 1;

    for entry in entries.iter().skip(start) {
        if y >= area.bottom().saturating_sub(1) { break; }

        let dot_color = match entry.risk {
            crate::state::RiskLevel::Low      => GREEN,
            crate::state::RiskLevel::Medium   => YELLOW,
            crate::state::RiskLevel::High     => AMBER,
            crate::state::RiskLevel::Critical => RED,
        };
        canvas.print(area.x + 1, y, "●", Style::new().fg(dot_color).bold());
        let avail = area.w.saturating_sub(4) as usize;
        let path = truncate_cells(&entry.path, avail);
        canvas.print(area.x + 3, y, &path, Style::new().fg(WHITE));
        if !entry.operation.is_empty() {
            let op = format!("[{}]", entry.operation);
            let op_x = area.right().saturating_sub(op.chars().count() as u16 + 2);
            canvas.print(op_x, y, &op, Style::new().fg(DIM));
        }
        y += 1;
    }
}

// ── Right panel: workers + checkpoint ─────────────────────────────────────────

fn render_workers_pane(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));

    if area.h < 8 {
        render_worker_identity(canvas, area, state);
        return;
    }

    let split = SplitPane::new(
        Axis::Vertical,
        vec![
            Constraint::Percent(28),
            Constraint::Percent(42),
            Constraint::Fill(1),
        ],
    );
    let (panels, handles) = split_panes(area, &split);
    canvas.with_clip(panels[0], |canvas| render_worker_identity(canvas, panels[0], state));
    render_split_handles(canvas, &handles, Axis::Vertical);
    canvas.with_clip(panels[1], |canvas| render_worker_thought(canvas, panels[1], state));
    canvas.with_clip(panels[2], |canvas| render_worker_blackboard(canvas, panels[2], state));
}

fn render_worker_identity(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    let Some(name) = active_worker_name(state) else {
        canvas.print(area.x + 1, area.y, "⬡ WORKER", Style::new().fg(CYAN).bold().bg(BG_ELEVATED));
        canvas.print(area.x + 2, area.y + 2, "sin worker enfocado", Style::new().fg(DIM).bg(BG_ELEVATED));
        return;
    };
    let worker = state.workers.workers.iter().find(|worker| worker.name == name);
    let display = worker
        .map(|worker| {
            if worker.display_name.is_empty() || worker.display_name == worker.name {
                agent_display_name(&worker.name)
            } else {
                worker.display_name.clone()
            }
        })
        .unwrap_or_else(|| agent_display_name(name));
    let status = worker.map(|worker| worker.status).unwrap_or(WorkerStatus::Running);
    let status_color = match status {
        WorkerStatus::Running => BLUE,
        WorkerStatus::Done => GREEN,
        WorkerStatus::Failed => RED,
        WorkerStatus::Warn => YELLOW,
        WorkerStatus::Waiting => DIM,
    };
    let title = format!("⬡ @{}", display.to_ascii_uppercase());
    canvas.print(area.x + 1, area.y, &truncate_cells(&title, area.w.saturating_sub(2) as usize), Style::new().fg(worker_color(name)).bold().bg(BG_ELEVATED));
    let status_label = format!("{:?}", status).to_ascii_uppercase();
    let status_x = area.right().saturating_sub(cell_width(&status_label) as u16 + 1);
    if status_x > area.x + 2 {
        canvas.print(status_x, area.y, &status_label, Style::new().fg(status_color).bold().bg(BG_ELEVATED));
    }

    let model = if state.session.model.is_empty() { "modelo activo" } else { state.session.model.as_str() };
    let elapsed = state
        .dashboard
        .metrics
        .elapsed_secs
        .map(|seconds| format!("{:02}:{:02}", seconds / 60, seconds % 60))
        .unwrap_or_else(|| "--:--".to_string());
    let tokens = fmt_tokens(worker.map(|worker| worker.token_count).unwrap_or(0));
    let iteration = worker
        .and_then(|worker| worker.iteration_current.zip(worker.iteration_total))
        .map(|(current, total)| format!("iter {current}/{total}"))
        .unwrap_or_else(|| "iter --".to_string());
    let meta = format!("{model} · {iteration} · tok {tokens} · {elapsed}");
    if area.h > 2 {
        canvas.print(area.x + 2, area.y + 2, &truncate_cells(&meta, area.w.saturating_sub(4) as usize), Style::new().fg(SECONDARY).bg(BG_ELEVATED));
    }
    if area.h > 4 {
        let intent = worker
            .and_then(|worker| worker.current_action.as_deref().or(worker.activity.as_deref()).or(worker.detail.as_deref()))
            .unwrap_or("esperando acción del worker");
        canvas.print(area.x + 2, area.y + 4, &truncate_cells(intent, area.w.saturating_sub(4) as usize), Style::new().fg(WHITE).bg(BG_ELEVATED));
    }
    if area.h > 5 {
        let file = worker
            .and_then(|worker| worker.current_file.as_deref())
            .or_else(|| (!state.diff.path.is_empty()).then_some(state.diff.path.as_str()))
            .unwrap_or("sin archivo activo");
        canvas.print(area.x + 2, area.y + 5, &truncate_cells(file, area.w.saturating_sub(4) as usize), Style::new().fg(DIM).bg(BG_ELEVATED));
    }
}

fn render_worker_thought(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_PANEL));
    canvas.print(area.x + 1, area.y, "⬡ THOUGHT STREAM", Style::new().fg(AMBER).bold().bg(BG_PANEL));
    let Some(name) = active_worker_name(state) else {
        canvas.print(area.x + 2, area.y + 2, "sin razonamiento activo", Style::new().fg(DIM).bg(BG_PANEL));
        return;
    };
    let chunks: Vec<_> = state
        .thought
        .chunks
        .iter()
        .filter(|chunk| chunk.coordinator == name)
        .collect();
    if chunks.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "esperando reasoning por IPC", Style::new().fg(DIM).bg(BG_PANEL));
        return;
    }
    let body_h = area.h.saturating_sub(2) as usize;
    let start = chunks.len().saturating_sub(body_h);
    let mut y = area.y + 2;
    for chunk in chunks.iter().skip(start) {
        if y >= area.bottom() {
            break;
        }
        let text = clean_thought(&chunk.content);
        if text.trim().is_empty() {
            continue;
        }
        canvas.print(area.x + 2, y, "↳", Style::new().fg(AMBER_DIM).bg(BG_PANEL));
        canvas.print(area.x + 4, y, &truncate_cells(&text, area.w.saturating_sub(6) as usize), Style::new().fg(SECONDARY).bg(BG_PANEL));
        y += 1;
    }
}

fn render_worker_blackboard(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.fill_rect(area, ' ', Style::new().bg(BG_ELEVATED));
    canvas.print(area.x + 1, area.y, "⬡ BLACKBOARD RELEVANTE", Style::new().fg(AMBER_BRIGHT).bold().bg(BG_ELEVATED));
    let Some(name) = active_worker_name(state) else {
        canvas.print(area.x + 2, area.y + 2, "sin worker enfocado", Style::new().fg(DIM).bg(BG_ELEVATED));
        return;
    };
    let active_file = state
        .workers
        .workers
        .iter()
        .find(|worker| worker.name == name)
        .and_then(|worker| worker.current_file.as_deref())
        .or_else(|| (!state.diff.path.is_empty()).then_some(state.diff.path.as_str()));
    let relevant: Vec<_> = state
        .dashboard
        .blackboard_events
        .iter()
        .filter(|event| {
            event.agent == name
                || event.agent == "architecture"
                || event.event_type.eq_ignore_ascii_case("constraint")
                || active_file.is_some_and(|file| event.content.contains(file))
        })
        .collect();
    if relevant.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "sin constraints visibles para este worker", Style::new().fg(DIM).bg(BG_ELEVATED));
        return;
    }
    let body_h = area.h.saturating_sub(2) as usize;
    let start = relevant.len().saturating_sub(body_h);
    let mut y = area.y + 2;
    for event in relevant.iter().skip(start) {
        if y >= area.bottom() {
            break;
        }
        let line = format!("[{}] {}", event.event_type.to_ascii_uppercase(), event.content);
        canvas.print(area.x + 2, y, &truncate_cells(&line, area.w.saturating_sub(4) as usize), Style::new().fg(SECONDARY).bg(BG_ELEVATED));
        y += 1;
    }
}

fn active_worker_name(state: &AppState) -> Option<&str> {
    state
        .focused_worker
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            if state.workers.active_coordinator.trim().is_empty() {
                None
            } else {
                Some(state.workers.active_coordinator.as_str())
            }
        })
        .or_else(|| {
            state
                .filemap
                .entries
                .iter()
                .find(|entry| entry.path == state.diff.path && !entry.agent.trim().is_empty())
                .map(|entry| entry.agent.as_str())
        })
        .or_else(|| {
            state
                .workers
                .workers
                .iter()
                .find(|worker| worker.status == WorkerStatus::Running)
                .map(|worker| worker.name.as_str())
        })
}

fn active_worker_tag(state: &AppState) -> &'static str {
    let Some(name) = active_worker_name(state) else {
        return "○ worker";
    };
    match tier_for(name) {
        AgentTier::Engineering => "● L2 worker",
        AgentTier::Planning => "● architect",
        AgentTier::Quality => "● quality",
        AgentTier::Gate => "● reviewer",
        AgentTier::Orchestrator => "● bee",
        AgentTier::OnDemand => "● ondemand",
    }
}

// ── Syntax highlighting helpers ───────────────────────────────────────────────

fn render_code_line(
    canvas: &mut Canvas,
    x: u16,
    y: u16,
    line: &str,
    max_width: usize,
    bg: Option<Style>,
) {
    // Draw background if needed
    if let Some(bg_style) = bg {
        for dx in 0..max_width.min(200) {
            canvas.print(x + dx as u16, y, " ", bg_style);
        }
    }

    let mut cx = x;
    let mut in_string = false;
    let mut string_delim = '\0';
    let mut buf = String::new();
    let mut drawn = 0usize;
    let chars: Vec<char> = line.chars().collect();

    for i in 0..chars.len() {
        if drawn >= max_width { break; }
        let ch = chars[i];

        if in_string {
            buf.push(ch);
            if ch == string_delim && (i == 0 || chars[i.saturating_sub(1)] != '\\') {
                let token_w = flush_ts_token(canvas, cx, y, &buf, true, bg, max_width, &mut drawn);
                cx = cx.saturating_add(token_w as u16);
                buf.clear();
                in_string = false;
            }
            continue;
        }

        if ch == '\'' || ch == '"' || ch == '`' {
            if !buf.is_empty() {
                let token_w = flush_ts_token(canvas, cx, y, &buf, false, bg, max_width, &mut drawn);
                cx = cx.saturating_add(token_w as u16);
                buf.clear();
            }
            in_string = true;
            string_delim = ch;
            buf.push(ch);
            continue;
        }

        if ch.is_alphanumeric() || ch == '_' || ch == '.' || ch == '/' {
            buf.push(ch);
        } else {
            if !buf.is_empty() {
                let token_w = flush_ts_token(canvas, cx, y, &buf, false, bg, max_width, &mut drawn);
                cx = cx.saturating_add(token_w as u16);
                buf.clear();
            }
            let ch_width = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(1).max(1);
            if drawn + ch_width <= max_width {
                canvas.print(cx, y, &ch.to_string(), Style::new().fg(WHITE).bg(bg.map(|s| s.bg).unwrap_or(crate::term::BG_PANEL)));
                cx = cx.saturating_add(ch_width as u16);
                drawn += ch_width;
            }
        }
    }

    if !buf.is_empty() && drawn < max_width {
        flush_ts_token(canvas, cx, y, &buf, in_string, bg, max_width, &mut drawn);
    }
}

fn flush_ts_token(
    canvas: &mut Canvas,
    x: u16,
    y: u16,
    token: &str,
    is_string: bool,
    bg: Option<Style>,
    max_width: usize,
    drawn: &mut usize,
) -> usize {
    let remaining = max_width.saturating_sub(*drawn);
    let token = truncate_cells(token, remaining);
    if token.is_empty() {
        return 0;
    }
    let base_bg = bg.map(|s| s.bg).unwrap_or(crate::term::BG_PANEL);
    let style = if is_string {
        Style::new().fg(GREEN).bg(base_bg)
    } else if is_ts_keyword(&token) {
        Style::new().fg(CYAN).bg(base_bg)
    } else if is_ts_type(&token) {
        Style::new().fg(PURPLE).bg(base_bg)
    } else {
        Style::new().fg(WHITE).bg(base_bg)
    };
    canvas.print(x, y, &token, style);
    let width = cell_width(&token);
    *drawn += width;
    width
}

fn is_ts_keyword(word: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "import", "export", "from", "const", "let", "var", "function", "async", "await",
        "if", "else", "return", "try", "catch", "throw", "new", "typeof", "instanceof",
        "class", "interface", "type", "default", "extends", "implements", "public", "private",
        "protected", "static", "readonly", "as", "in", "of", "for", "while", "do", "switch",
        "case", "break", "continue", "yield", "void", "delete", "debugger", "with",
    ];
    KEYWORDS.contains(&word)
}

fn is_ts_type(word: &str) -> bool {
    const TYPES: &[&str] = &[
        "string", "number", "boolean", "void", "any", "unknown", "never", "null", "undefined",
        "object", "symbol", "bigint", "Promise", "Array", "Map", "Set", "Record", "Partial",
        "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract", "ReturnType",
        "Request", "Response", "NextFunction", "Error", "Date", "RegExp", "Buffer",
    ];
    TYPES.contains(&word)
}

fn clean_thought(content: &str) -> String {
    content
        .replace("<think>", "")
        .replace("</think>", "")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::DiffLine;

    #[test]
    fn code_line_renderer_respects_cell_width_for_long_tokens() {
        let mut canvas = Canvas::new(24, 1);

        render_code_line(
            &mut canvas,
            0,
            0,
            "const very_long_identifier_tail = 1;",
            10,
            None,
        );
        let row = canvas.to_text_rows()[0].clone();

        assert!(!row.contains("tail"));
        assert!(cell_width(row.trim_end()) <= 10);
    }

    #[test]
    fn code_line_renderer_counts_wide_cells() {
        let mut canvas = Canvas::new(12, 1);

        render_code_line(&mut canvas, 0, 0, "abc🐝TAIL", 4, None);
        let row = canvas.to_text_rows()[0].clone();

        assert!(row.contains("abc"));
        assert!(!row.contains("TAIL"));
    }

    #[test]
    fn diff_footer_renders_line_count_when_diff_fits() {
        let mut state = AppState::default();
        state.diff.path = "src/auth/middleware.ts".to_string();
        state.diff.lines = vec![
            DiffLine {
                kind: "context".to_string(),
                text: "export async function authGuard() {".to_string(),
                old_line_no: Some(1),
                new_line_no: Some(1),
            },
            DiffLine {
                kind: "add".to_string(),
                text: "  await rateLimit.tap(payload.sub);".to_string(),
                old_line_no: None,
                new_line_no: Some(2),
            },
        ];

        let mut canvas = Canvas::new(100, 16);
        render(&mut canvas, Rect::new(0, 0, 100, 16), &state);
        let rows = canvas.to_text_rows().join("\n");

        assert!(rows.contains("diff completo"));
    }
}
