use crate::{
    state::{AppState, RiskLevel, Role, WorkerStatus},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, DIM, GREEN, RED, SECONDARY, WHITE, YELLOW, BG_ELEVATED},
    widgets::components::{agent_display_name, render_scrollbar, worker_color},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if state.history.entries.is_empty() {
        render_empty(canvas, area, state);
        return;
    }

    let expanded_idx = expanded_entry_index(state);

    // Expanded turn: content lines + header + gap + buffer
    let expanded_lines = count_expanded_lines(state, area.w as usize, expanded_idx);
    let expanded_desired = (expanded_lines as u16 + 3).min(area.h);
    let remaining = area.h.saturating_sub(expanded_desired);

    // Compact turns: 1 row per past entry + 1 separator — never allocate more than needed
    let compact_entries = state.history.entries.len().saturating_sub(1);
    let compact_max = if compact_entries == 0 || remaining < 2 {
        0
    } else {
        (compact_entries as u16 + 1).min(remaining)
    };
    let compact_h = compact_max;
    let expanded_h = area.h.saturating_sub(compact_h);

    let compact_area = Rect::new(area.x, area.y, area.w, compact_h);
    let expanded_area = Rect::new(area.x, area.y + compact_h, area.w, expanded_h);

    render_compact_turns(canvas, compact_area, state, expanded_idx);
    render_expanded_turn(canvas, expanded_area, state, expanded_idx);
}

// ── Turns pasados: 1 línea por turn ──────────────────────────────────────────

fn render_compact_turns(canvas: &mut Canvas, area: Rect, state: &AppState, expanded_idx: usize) {
    // Need at least 2 rows: 1+ entries + 1 separator line
    if area.h < 2 || state.history.entries.len() < 2 {
        return;
    }

    let avail_w = area.w.saturating_sub(4) as usize;
    let indices = compact_entry_indices(state, expanded_idx);
    // Reserve last row for separator — entries only fill rows [area.y .. area.bottom()-1)
    let entries_h = area.h.saturating_sub(1);
    let count = indices.len().min(entries_h as usize);
    let start = indices.len().saturating_sub(count);

    let mut y = area.y + entries_h.saturating_sub(count as u16);
    for idx in indices.into_iter().skip(start) {
        if y >= area.y + entries_h { break; }
        let entry = &state.history.entries[idx];

        if let Some(ref agent_name) = entry.agent {
            let col = worker_color(agent_name);
            let name = agent_display_name(agent_name);
            let name_shown: String = name.chars().take(14).collect();
            let label = format!("⬡ {}", name_shown);
            canvas.print(area.x + 1, y, &label, Style::new().fg(col).bold());

            // First line of content after agent name
            let first_line = entry.content.lines().next().unwrap_or("").trim();
            let label_end = area.x + 1 + label.chars().count() as u16 + 1;
            let ts_width = entry.timestamp.as_ref().map(|t| t.chars().count() as u16 + 3).unwrap_or(3);
            let content_avail = area.right().saturating_sub(label_end + ts_width + 2) as usize;
            if content_avail > 5 && !first_line.is_empty() {
                let shown: String = first_line.chars().take(content_avail).collect();
                canvas.print(label_end, y, &shown, Style::new().fg(SECONDARY));
            }

            if let Some(ref ts) = entry.timestamp {
                let ts_x = area.right().saturating_sub(ts.chars().count() as u16 + 3);
                canvas.print(ts_x, y, ts, Style::new().fg(DIM));
            }

            let ellipsis = if entry.content.lines().count() > 1 || entry.content.len() > avail_w.saturating_sub(label.len() + 4) { "…" } else { "✓" };
            let check_x = area.right().saturating_sub(2);
            canvas.print(check_x, y, ellipsis, Style::new().fg(DIM));
        } else {
            let (prefix, pfx_style) = match entry.role {
                Role::User      => ("▸ ", Style::new().fg(AMBER_DIM)),
                Role::Assistant => ("  ", Style::new().fg(DIM)),
                Role::System    => ("⚙ ", Style::new().fg(DIM)),
                Role::Shell     => ("$ ", Style::new().fg(DIM)),
                Role::Thinking  => ("… ", Style::new().fg(DIM)),
            };

            let first_line = entry.content.lines().next().unwrap_or("").trim();
            let max_content = avail_w.saturating_sub(prefix.len() + 3);
            let shown: String = first_line.chars().take(max_content).collect();
            let ellipsis = if entry.content.lines().count() > 1 || first_line.len() > max_content { "…" } else { "✓" };

            canvas.print(area.x + 1, y, prefix, pfx_style);
            canvas.print(area.x + 1 + prefix.len() as u16, y, &shown, Style::new().fg(DIM));
            let check_x = area.right().saturating_sub(2);
            canvas.print(check_x, y, ellipsis, Style::new().fg(DIM));
        }

        y += 1;
    }

    // Separador en la última fila del área compacta (nunca pisa las entradas)
    let sep: String = std::iter::repeat('─').take(area.w as usize).collect();
    canvas.print(area.x, area.bottom().saturating_sub(1), &sep, Style::new().fg(AMBER_DIM));
}

// ── Turn actual: expandido con markdown + actividad live + filemap ────────────

fn render_expanded_turn(canvas: &mut Canvas, area: Rect, state: &AppState, last_idx: usize) {
    if area.h < 2 { return; }

    let entry = &state.history.entries[last_idx];
    let mut y = area.y;

    // Cabecera: la pregunta del usuario (rol User) o el prefix del turn
    let (prefix, pfx_style) = match entry.role {
        Role::User      => ("▸ ", Style::new().fg(AMBER).bold()),
        Role::Assistant => ("  ", Style::new().fg(SECONDARY)),
        Role::System    => ("⚙ ", Style::new().fg(DIM)),
        Role::Shell     => ("$ ", Style::new().fg(GREEN)),
        Role::Thinking  => ("… ", Style::new().fg(DIM)),
    };

    // Mostrar la pregunta del usuario siempre como cabecera:
    // - Si el último entry ES el User (recién enviado, sin respuesta aún) → usarlo directamente
    // - Si el último es Assistant → buscar el User anterior
    let question: Option<&str> = match entry.role {
        Role::User => Some(entry.content.as_str()),
        Role::Assistant if last_idx > 0 => {
            let prev = &state.history.entries[last_idx - 1];
            if prev.role == Role::User { Some(prev.content.as_str()) } else { None }
        }
        _ => None,
    };

    if let Some(q) = question {
        let q_line: String = q.lines().next().unwrap_or("").chars()
            .take(area.w.saturating_sub(4) as usize).collect();
        canvas.print(area.x + 1, y, "▸ ", Style::new().fg(AMBER).bold());
        canvas.print(area.x + 3, y, &q_line, Style::new().fg(WHITE).bold());
        y += 1;
    }

    // Header del agente para el turn expandido
    if let Some(ref agent_name) = entry.agent {
        let col = worker_color(agent_name);
        let name = agent_display_name(agent_name);
        let name_shown: String = name.chars().take(20).collect();
        let label = format!("⬡ {}", name_shown);
        canvas.print(area.x + 1, y, &label, Style::new().fg(col).bold());

        if let Some(ref ts) = entry.timestamp {
            let ts_x = area.right().saturating_sub(ts.chars().count() as u16 + 1);
            canvas.print(ts_x, y, ts, Style::new().fg(DIM));
        }
        y += 1;
    }

    // Si está corriendo: mostrar actividad live (workers + pensamiento reciente)
    if state.running && !state.history_nav_mode {
        render_live_activity(canvas, area, state, y);
        return;
    }

    // Respuesta completa con markdown mínimo
    y += 1; // pequeño gap
    let content_w = area.w.saturating_sub(4) as usize;
    let mut response_overflows = false;

    if entry.role == Role::Assistant || entry.role == Role::System {
        let response_lines = build_response_lines(&entry.content, content_w);
        let body_y = y;
        let visible_h = area.bottom().saturating_sub(body_y + 1) as usize;
        let max_scroll = response_lines.len().saturating_sub(visible_h);
        let scroll = state.history.scroll.min(max_scroll);
        response_overflows = max_scroll > 0;

        for line in response_lines.iter().skip(scroll).take(visible_h) {
            if line.inline_code {
                print_line_with_inline_code(
                    canvas,
                    area.x + 2 + line.indent,
                    y,
                    &line.text,
                    content_w.saturating_sub(line.indent as usize),
                    line.style,
                    Style::new().fg(GREEN),
                );
            } else {
                canvas.print(area.x + 2 + line.indent, y, &line.text, line.style);
            }
            y += 1;
        }

        if response_overflows {
            render_scrollbar(
                canvas,
                Rect::new(
                    area.right().saturating_sub(1),
                    body_y,
                    1,
                    visible_h as u16,
                ),
                response_lines.len(),
                scroll,
                Style::new().fg(AMBER_DIM),
                Style::new().fg(DIM),
            );
            let hint = "PgUp/PgDn · rueda";
            canvas.print(
                area.right().saturating_sub(hint.chars().count() as u16 + 2),
                area.bottom().saturating_sub(1),
                hint,
                Style::new().fg(DIM),
            );
        }
    } else if entry.role == Role::User {
        // La pregunta ya fue mostrada como cabecera — nada más que mostrar aquí
        canvas.print(area.x + 2, y, "esperando respuesta…", Style::new().fg(DIM));
    } else {
        // Shell / Thinking: mostrar tal cual con prefix
        canvas.print(area.x + 1, y, prefix, pfx_style);
        let shown: String = entry.content.lines().next().unwrap_or("").chars().take(content_w).collect();
        canvas.print(area.x + 1 + prefix.len() as u16, y, &shown, Style::new().fg(SECONDARY));
    }

    // Filemap inline: archivos producidos en este task
    if !response_overflows && !state.filemap.entries.is_empty() && y < area.bottom().saturating_sub(2) {
        y += 1;
        let max_files = (area.bottom().saturating_sub(y + 1)) as usize;
        for entry in state.filemap.entries.iter().take(max_files) {
            if y >= area.bottom().saturating_sub(1) { break; }
            let dot_color = match entry.risk {
                RiskLevel::Low      => GREEN,
                RiskLevel::Medium   => YELLOW,
                RiskLevel::High     => AMBER,
                RiskLevel::Critical => RED,
            };
            canvas.print(area.x + 2, y, "·", Style::new().fg(dot_color));
            let path: String = entry.path.chars().take(area.w.saturating_sub(6) as usize).collect();
            canvas.print(area.x + 4, y, &path, Style::new().fg(DIM));
            if !entry.operation.is_empty() {
                let op_x = area.right().saturating_sub(entry.operation.len() as u16 + 1);
                canvas.print(op_x, y, &entry.operation, Style::new().fg(DIM));
            }
            y += 1;
        }
    }
}

// ── Actividad live mientras los workers corren ────────────────────────────────

fn render_live_activity(canvas: &mut Canvas, area: Rect, state: &AppState, start_y: u16) {
    let mut y = start_y;

    let active_workers: Vec<_> = state.workers.workers.iter()
        .filter(|w| matches!(w.status, WorkerStatus::Running))
        .collect();

    // Spinner frames using anim_tick
    let spinner_frames = &["◐", "◓", "◑", "◒"];
    let spinner = spinner_frames[(state.anim_tick as usize) % spinner_frames.len()];

    // Header: show active coordinator or generic processing
    if let Some(first_active) = active_workers.first() {
        let display = if first_active.display_name.is_empty() {
            agent_display_name(&first_active.name)
        } else {
            first_active.display_name.clone()
        };
        let col = worker_color(&first_active.name);
        let header = format!("{} {} está trabajando…", spinner, display);
        canvas.print(area.x + 2, y, &header, Style::new().fg(col).bold());
        y += 1;
    } else if !state.thought.chunks.is_empty() {
        let last_chunk = state.thought.chunks.last().unwrap();
        let display = agent_display_name(&last_chunk.coordinator);
        let col = worker_color(&last_chunk.coordinator);
        let header = format!("{} {} está pensando…", spinner, display);
        canvas.print(area.x + 2, y, &header, Style::new().fg(col).bold());
        y += 1;
    } else {
        let header = format!("{} Procesando…", spinner);
        canvas.print(area.x + 2, y, &header, Style::new().fg(AMBER_BRIGHT).bold());
        y += 1;
    }

    y += 1; // gap

    // Show thought stream or worker details
    if !state.thought.chunks.is_empty() {
        let avail_h = area.bottom().saturating_sub(y + 1) as usize;
        let chunks = &state.thought.chunks;
        let start = chunks.len().saturating_sub(avail_h);
        for chunk in chunks.iter().skip(start) {
            if y >= area.bottom().saturating_sub(1) { break; }
            let col = worker_color(&chunk.coordinator);
            let (prefix, prefix_style, content_style) = if chunk.phase.contains("think") || chunk.phase.contains("reason") {
                ("↳ ", Style::new().fg(DIM), Style::new().fg(DIM))
            } else {
                ("⬡ ", Style::new().fg(col).bold(), Style::new().fg(SECONDARY))
            };
            canvas.print(area.x + 2, y, prefix, prefix_style);
            let avail = area.w.saturating_sub(5) as usize;
            let shown: String = chunk.content.chars().take(avail).collect();
            canvas.print(area.x + 4, y, &shown, content_style);
            y += 1;
        }
    } else if !active_workers.is_empty() {
        for w in active_workers.iter().take(3) {
            if y >= area.bottom().saturating_sub(1) { break; }
            let wcolor = worker_color(&w.name);
            let display = if w.display_name.is_empty() { agent_display_name(&w.name) } else { w.display_name.clone() };
            let activity = w.activity.as_deref().or(w.detail.as_deref()).unwrap_or("");
            let line = format!("⬡ {} · {}", display, activity);
            let shown: String = line.chars().take((area.w.saturating_sub(4)) as usize).collect();
            canvas.print(area.x + 2, y, &shown, Style::new().fg(wcolor));
            y += 1;
        }
    } else {
        canvas.print(area.x + 2, y, "esperando respuesta…", Style::new().fg(DIM));
    }
}

// ── Estado vacío ──────────────────────────────────────────────────────────────

fn render_empty(canvas: &mut Canvas, area: Rect, _state: &AppState) {
    let y = area.y + area.h / 3;
    canvas.print(area.x + 2, y, "Escribe tu primera tarea y presiona Enter", Style::new().fg(DIM));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn count_expanded_lines(state: &AppState, _width: usize, expanded_idx: usize) -> usize {
    let entry = &state.history.entries[expanded_idx];
    // Contar líneas del contenido + espacio para filemap
    let content_w = _width.saturating_sub(4).max(1);
    let content_lines = if entry.role == Role::Assistant || entry.role == Role::System {
        build_response_lines(&entry.content, content_w).len()
    } else {
        entry.content.lines().count().max(1)
    };
    let filemap_lines = state.filemap.entries.len().min(5);
    content_lines + filemap_lines + 3 // 3 = cabecera + gap + buffer
}

fn expanded_entry_index(state: &AppState) -> usize {
    let last_idx = state.history.entries.len().saturating_sub(1);
    if state.history_nav_mode {
        state.history.selected.unwrap_or(last_idx).min(last_idx)
    } else {
        last_idx
    }
}

fn compact_entry_indices(state: &AppState, expanded_idx: usize) -> Vec<usize> {
    (0..state.history.entries.len())
        .filter(|idx| *idx != expanded_idx)
        .collect()
}

#[derive(Clone)]
struct ResponseLine {
    text: String,
    style: Style,
    inline_code: bool,
    indent: u16,
}

fn build_response_lines(content: &str, width: usize) -> Vec<ResponseLine> {
    crate::ui::build_markdown_lines(content, width)
        .into_iter()
        .map(|line| ResponseLine {
            inline_code: line.text.contains('`') && line.style.bg != BG_ELEVATED,
            text: line.text,
            style: line.style,
            indent: line.indent,
        })
        .collect()
}

/// Renderiza una línea de texto resaltando segmentos entre backticks (`code`) en color verde.
fn print_line_with_inline_code(
    canvas: &mut Canvas,
    x: u16,
    y: u16,
    line: &str,
    max_width: usize,
    base_style: Style,
    code_style: Style,
) {
    let mut chars = line.chars().peekable();
    let mut cx = x;
    let mut in_code = false;
    let mut buf = String::new();
    let mut drawn = 0usize;

    while let Some(ch) = chars.next() {
        if drawn >= max_width {
            break;
        }
        if ch == '`' {
            // Flush buffer acumulado
            if !buf.is_empty() {
                let slice: String = buf.chars().take(max_width - drawn).collect();
                canvas.print(cx, y, &slice, if in_code { code_style } else { base_style });
                cx += slice.chars().count() as u16;
                drawn += slice.chars().count();
                buf.clear();
            }
            in_code = !in_code;
            continue;
        }
        buf.push(ch);
    }
    if !buf.is_empty() && drawn < max_width {
        let slice: String = buf.chars().take(max_width - drawn).collect();
        canvas.print(cx, y, &slice, if in_code { code_style } else { base_style });
    }
}

// Kept for external callers (controller.rs uses entry_at_y for click detection)
pub fn entry_at_y(state: &AppState, area: Rect, y: u16) -> Option<usize> {
    if state.history.entries.is_empty() || y < area.y || y >= area.bottom() {
        return None;
    }

    let expanded_idx = expanded_entry_index(state);
    let expanded_lines = count_expanded_lines(state, area.w as usize, expanded_idx);
    let expanded_desired = (expanded_lines as u16 + 3).min(area.h);
    let remaining = area.h.saturating_sub(expanded_desired);
    let compact_entries = state.history.entries.len().saturating_sub(1);
    let compact_h = if compact_entries == 0 || remaining < 2 {
        0
    } else {
        (compact_entries as u16 + 1).min(remaining)
    };

    if y >= area.y + compact_h {
        return Some(expanded_idx);
    }

    let entries_h = compact_h.saturating_sub(1);
    if entries_h == 0 || y == area.y + compact_h.saturating_sub(1) {
        return None;
    }
    let indices = compact_entry_indices(state, expanded_idx);
    let count = indices.len().min(entries_h as usize);
    let first_y = area.y + entries_h.saturating_sub(count as u16);
    if y < first_y || y >= first_y + count as u16 {
        return None;
    }
    indices
        .get(indices.len().saturating_sub(count) + (y - first_y) as usize)
        .copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::HistoryEntry;

    #[test]
    fn focus_wraps_a_long_generated_line_instead_of_losing_its_tail() {
        let mut state = AppState::default();
        state.history.entries.push(HistoryEntry {
            role: Role::Assistant,
            content: "primera parte suficientemente larga VISIBLE_TAIL".to_string(),
            agent: Some("bee".to_string()),
            timestamp: None,
        });

        let mut canvas = Canvas::new(32, 10);
        render(&mut canvas, Rect::new(0, 0, 32, 10), &state);

        assert!(
            canvas
                .to_text_rows()
                .iter()
                .any(|row| row.contains("VISIBLE_TAIL")),
            "el texto situado después del ancho de Focus debe mostrarse en una fila siguiente"
        );
    }

    #[test]
    fn focus_scroll_exposes_later_response_rows_and_draws_a_scrollbar() {
        let mut state = AppState::default();
        state.history.entries.push(HistoryEntry {
            role: Role::Assistant,
            content: (0..12)
                .map(|line| format!("line-{line:02}"))
                .collect::<Vec<_>>()
                .join("\n"),
            agent: Some("bee".to_string()),
            timestamp: None,
        });
        state.history.scroll = 4;

        let mut canvas = Canvas::new(32, 8);
        render(&mut canvas, Rect::new(0, 0, 32, 8), &state);
        let rows = canvas.to_text_rows();

        assert!(rows.iter().any(|row| row.contains("line-04")));
        assert!(rows.iter().any(|row| row.contains('█')));
    }

    #[test]
    fn focus_wraps_wide_characters_before_the_tail_reaches_the_clip_edge() {
        let mut state = AppState::default();
        state.history.entries.push(HistoryEntry {
            role: Role::Assistant,
            content: format!("{}TAIL", "🐝".repeat(10)),
            agent: None,
            timestamp: None,
        });

        let area = Rect::new(0, 0, 20, 8);
        let mut canvas = Canvas::new(area.w, area.h);
        canvas.with_clip(area, |canvas| render(canvas, area, &state));

        assert!(
            canvas.to_text_rows().iter().any(|row| row.contains("TAIL")),
            "los caracteres de doble ancho no deben ocultar el final de la respuesta"
        );
    }

    #[test]
    fn selected_compact_action_is_expanded_for_inspection() {
        let mut state = AppState::default();
        state.history.entries.push(HistoryEntry {
            role: Role::System,
            content: "tool action\nresultado completo visible".to_string(),
            agent: Some("bee".to_string()),
            timestamp: None,
        });
        state.history.entries.push(HistoryEntry {
            role: Role::Assistant,
            content: "respuesta final".to_string(),
            agent: Some("bee".to_string()),
            timestamp: None,
        });
        state.history_nav_mode = true;
        state.history.selected = Some(0);
        state.running = true;

        let mut canvas = Canvas::new(48, 12);
        render(&mut canvas, Rect::new(0, 0, 48, 12), &state);

        assert!(canvas
            .to_text_rows()
            .iter()
            .any(|row| row.contains("resultado completo visible")));
    }

    #[test]
    fn compact_rows_resolve_to_clickable_history_entries() {
        let mut state = AppState::default();
        state.history.entries = (0..3)
            .map(|idx| HistoryEntry {
                role: Role::System,
                content: format!("action-{idx}"),
                agent: None,
                timestamp: None,
            })
            .collect();

        let area = Rect::new(0, 0, 48, 12);
        assert_eq!(entry_at_y(&state, area, area.y), Some(0));
        assert_eq!(entry_at_y(&state, area, area.y + 1), Some(1));
    }
}
