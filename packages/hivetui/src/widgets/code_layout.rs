use crate::{
    state::{AppState, WorkerStatus},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, BG_ELEVATED, BG_PANEL, BLUE, CYAN, DIM, GREEN, PURPLE, RED, SECONDARY, WHITE, YELLOW},
    ui::{cell_width, render_split_handles, split_panes, truncate_cells, Axis, Constraint, SplitPane},
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

    let hl_shown = truncate_cells(&header_left, area.w.saturating_sub(3) as usize);
    canvas.print(area.x + 1, area.y, &hl_shown, Style::new().fg(AMBER).bold());

    if !header_right.is_empty() {
        let hr_x = area.right().saturating_sub(header_right.chars().count() as u16 + 1);
        if hr_x > area.x + 1 + cell_width(&hl_shown) as u16 {
            canvas.print(hr_x, area.y, &header_right, Style::new().fg(DIM));
        }
    }

    // Backend indicator top-right
    let backend_tag = "○ backend";
    let backend_x = area.right().saturating_sub(backend_tag.chars().count() as u16 + 1);
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

    // Scroll indicator
    if state.diff.lines.len() > avail_h {
        let total = state.diff.lines.len();
        let pct = (start * 100) / total.max(1);
        let hint = format!("{}% · ↑↓", pct);
        canvas.print(area.right().saturating_sub(cell_width(&hint) as u16 + 1),
                     area.bottom().saturating_sub(1), &hint, Style::new().fg(DIM));
    }
}

fn render_filemap_fallback(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.print(area.x + 1, area.y, "⬡ ARCHIVOS MODIFICADOS", Style::new().fg(AMBER).bold());

    let avail_h = area.h.saturating_sub(2) as usize;
    let entries = &state.filemap.entries;

    if entries.is_empty() {
        canvas.print(area.x + 2, area.y + 2, "sin cambios en curso", Style::new().fg(DIM));
        canvas.print(area.x + 2, area.y + 3,
            "Los diffs aparecerán aquí cuando los workers escriban archivos.",
            Style::new().fg(DIM));
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

    let workers_h = if area.h > 10 {
        area.h * state.panels.code_workers_percent / 100
    } else {
        area.h
    };
    let split = SplitPane::new(
        Axis::Vertical,
        vec![
            Constraint::Fixed(workers_h),
            Constraint::Fill(1),
        ],
    );
    let (panels, handles) = split_panes(area, &split);
    canvas.with_clip(panels[0], |canvas| render_all_workers(canvas, panels[0], state));
    render_split_handles(canvas, &handles, Axis::Vertical);
    if area.h > 10 {
        canvas.with_clip(panels[1], |canvas| render_checkpoint_card(canvas, panels[1], state));
    }
}

fn render_all_workers(canvas: &mut Canvas, area: Rect, state: &AppState) {
    canvas.print(area.x + 1, area.y, "⬡ WORKERS · ESTADO LIVE", Style::new().fg(CYAN).bold());

    if state.workers.workers.is_empty() {
        canvas.print(area.x + 2, area.y + 1, "sin workers activos", Style::new().fg(DIM));
        return;
    }

    let mut y = area.y + 2;
    let mut idle_count = 0;

    for w in state.workers.workers.iter() {
        if y >= area.bottom().saturating_sub(2) { break; }

        let (dot, dot_color) = match w.status {
            WorkerStatus::Running => ("●", GREEN),
            WorkerStatus::Done    => ("○", DIM),
            WorkerStatus::Failed  => ("✗", RED),
            WorkerStatus::Warn    => ("●", YELLOW),
            WorkerStatus::Waiting => ("○", DIM),
        };

        let status_label = match w.status {
            WorkerStatus::Running => "RUNNING",
            WorkerStatus::Done    => "DONE",
            WorkerStatus::Failed  => "FAILED",
            WorkerStatus::Warn    => "WARN",
            WorkerStatus::Waiting => "WAITING",
        };

        let status_color = match w.status {
            WorkerStatus::Running => GREEN,
            WorkerStatus::Done    => DIM,
            WorkerStatus::Failed  => RED,
            WorkerStatus::Warn    => YELLOW,
            WorkerStatus::Waiting => DIM,
        };

        let display = if w.display_name.is_empty() {
            agent_display_name(&w.name)
        } else {
            w.display_name.clone()
        };

        let wcolor = worker_color(&w.name);

        // Dot
        canvas.print(area.x + 1, y, dot, Style::new().fg(dot_color).bold());

        // Name
        let name_x = area.x + 3;
        canvas.print(name_x, y, "⬡", Style::new().fg(wcolor));
        canvas.print(name_x + 2, y, &display, Style::new().fg(wcolor).bold());

        // Status label
        let status_x = name_x + 2 + cell_width(&display) as u16 + 2;
        canvas.print(status_x, y, status_label, Style::new().fg(status_color));

        // Activity description
        let activity_text = w.activity.as_deref().or(w.detail.as_deref()).unwrap_or("");
        if !activity_text.is_empty() {
            let act_x = status_x + status_label.len() as u16 + 2;
            let avail = area.right().saturating_sub(act_x + 1) as usize;
            if avail > 3 {
                let shown = truncate_cells(activity_text, avail);
                canvas.print(act_x, y, &shown, Style::new().fg(SECONDARY));
            }
        }

        if w.status == WorkerStatus::Waiting {
            idle_count += 1;
        }

        y += 1;
    }

    // Idle agents footer
    if idle_count > 0 && y < area.bottom().saturating_sub(1) {
        let idle_names: Vec<_> = state.workers.workers.iter()
            .filter(|w| w.status == WorkerStatus::Waiting)
            .map(|w| if w.display_name.is_empty() { agent_display_name(&w.name) } else { w.display_name.clone() })
            .collect();
        if !idle_names.is_empty() {
            let footer = format!("○ ---- {} agents idle ({}) ---- ○", idle_count, idle_names.join(" · "));
            let shown = truncate_cells(&footer, area.w.saturating_sub(2) as usize);
            canvas.print(area.x + 1, y, &shown, Style::new().fg(DIM));
        }
    }
}

fn render_checkpoint_card(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if area.h < 4 { return; }

    let Some(cp) = state.checkpoints.entries.last() else {
        canvas.print(area.x + 1, area.y + 1, "sin checkpoints", Style::new().fg(DIM));
        return;
    };

    canvas.fill_rect(
        crate::term::Rect::new(area.x, area.y, area.w, area.h.min(6)),
        ' ',
        Style::new().bg(crate::term::BG_ELEVATED),
    );

    let time_part = if cp.time.is_empty() { String::new() } else { format!(" · {}", cp.time) };
    let header = format!("⬡ CHECKPOINT{time_part} ●");
    canvas.print(area.x + 1, area.y, &header, Style::new().fg(AMBER_BRIGHT).bold());

    // Test stats
    let mut y = area.y + 1;
    if cp.tests_total > 0 {
        let test_color = if cp.tests_passed == cp.tests_total { GREEN } else { YELLOW };
        let test_text = format!("tests verdes {}/{}", cp.tests_passed, cp.tests_total);
        canvas.print(area.x + 1, y, &test_text, Style::new().fg(test_color));
        y += 1;
    }

    let desc = truncate_cells(&cp.description, area.w.saturating_sub(3) as usize);
    canvas.print(area.x + 1, y, &desc, Style::new().fg(SECONDARY));
    y += 1;

    let files = format!("{} archivos  ⬡ {}", cp.file_count, cp.agent);
    canvas.print(area.x + 1, y, &files, Style::new().fg(DIM));
    y += 1;

    if area.h > 4 {
        canvas.print(area.x + 1, y, "[↩ r] rollback · o presiona r", Style::new().fg(RED));
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
