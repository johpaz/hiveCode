use crate::{
    state::{AppState, RiskLevel, Role, WorkerStatus},
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, DIM, GREEN, RED, SECONDARY, WHITE, YELLOW, BG_ELEVATED},
};

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    if state.history.entries.is_empty() {
        render_empty(canvas, area, state);
        return;
    }

    let last_idx = state.history.entries.len().saturating_sub(1);

    // Determinar cuántas filas necesita el turn actual expandido
    let expanded_lines = count_expanded_lines(state, area.w as usize);
    let expanded_h = (expanded_lines as u16 + 3).min(area.h);

    // El resto del espacio es para los turns pasados compactos
    let compact_h = area.h.saturating_sub(expanded_h);
    let compact_area = Rect::new(area.x, area.y, area.w, compact_h);
    let expanded_area = Rect::new(area.x, area.y + compact_h, area.w, expanded_h);

    render_compact_turns(canvas, compact_area, state, last_idx);
    render_expanded_turn(canvas, expanded_area, state, last_idx);
}

// ── Turns pasados: 1 línea por turn ──────────────────────────────────────────

fn render_compact_turns(canvas: &mut Canvas, area: Rect, state: &AppState, last_idx: usize) {
    // Need at least 2 rows: 1+ entries + 1 separator line
    if area.h < 2 || last_idx == 0 {
        return;
    }

    let avail_w = area.w.saturating_sub(4) as usize;
    let entries = &state.history.entries[..last_idx];
    // Reserve last row for separator — entries only fill rows [area.y .. area.bottom()-1)
    let entries_h = area.h.saturating_sub(1);
    let count = entries.len().min(entries_h as usize);
    let start = entries.len().saturating_sub(count);

    let mut y = area.y + entries_h.saturating_sub(count as u16);
    for entry in entries.iter().skip(start) {
        if y >= area.y + entries_h { break; }

        let (prefix, pfx_style) = match entry.role {
            Role::User      => ("▸ ", Style::new().fg(AMBER_DIM)),
            Role::Assistant => ("  ", Style::new().fg(DIM)),
            Role::System    => ("⚙ ", Style::new().fg(DIM)),
            Role::Shell     => ("$ ", Style::new().fg(DIM)),
            Role::Thinking  => ("… ", Style::new().fg(DIM)),
        };

        // Primera línea del contenido
        let first_line = entry.content.lines().next().unwrap_or("").trim();
        let max_content = avail_w.saturating_sub(prefix.len() + 3);
        let shown: String = first_line.chars().take(max_content).collect();
        let ellipsis = if entry.content.lines().count() > 1 || first_line.len() > max_content { "…" } else { "✓" };

        canvas.print(area.x + 1, y, prefix, pfx_style);
        canvas.print(area.x + 1 + prefix.len() as u16, y, &shown, Style::new().fg(DIM));
        let check_x = area.right().saturating_sub(2);
        canvas.print(check_x, y, ellipsis, Style::new().fg(DIM));

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

    // Si está corriendo: mostrar actividad live (workers + pensamiento reciente)
    if state.running {
        render_live_activity(canvas, area, state, y);
        return;
    }

    // Respuesta completa con markdown mínimo
    y += 1; // pequeño gap
    let content_w = area.w.saturating_sub(4) as usize;

    if entry.role == Role::Assistant || entry.role == Role::System {
        let mut in_code_block = false;
        for raw_line in entry.content.lines() {
            if y >= area.bottom().saturating_sub(1) { break; }

            if raw_line.starts_with("```") {
                in_code_block = !in_code_block;
                if in_code_block {
                    let lang: String = raw_line.trim_start_matches('`').chars().take(content_w).collect();
                    canvas.print(area.x + 2, y, &lang, Style::new().fg(DIM));
                }
                y += 1;
                continue;
            }

            if in_code_block {
                let shown: String = raw_line.chars().take(content_w).collect();
                canvas.print(area.x + 3, y, &shown, Style::new().fg(GREEN).bg(BG_ELEVATED));
                y += 1;
                continue;
            }

            let (style, skip) = if raw_line.starts_with("### ") {
                (Style::new().fg(AMBER_DIM).bold(), 4)
            } else if raw_line.starts_with("## ") {
                (Style::new().fg(AMBER).bold(), 3)
            } else if raw_line.starts_with("# ") {
                (Style::new().fg(AMBER_BRIGHT).bold(), 2)
            } else if raw_line.starts_with("- ") || raw_line.starts_with("· ") || raw_line.starts_with("* ") {
                (Style::new().fg(SECONDARY), 0)
            } else if raw_line.is_empty() {
                y += 1;
                continue;
            } else {
                (Style::new().fg(WHITE), 0)
            };

            let content: String = raw_line.chars().skip(skip).take(content_w).collect();
            canvas.print(area.x + 2, y, &content, style);
            y += 1;
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
    if !state.filemap.entries.is_empty() && y < area.bottom().saturating_sub(2) {
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

    let active_workers = state.workers.workers.iter()
        .filter(|w| matches!(w.status, WorkerStatus::Running))
        .count();

    // Sin workers activos: mostrar stream de pensamiento o indicador de espera
    if active_workers == 0 {
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
        } else {
            canvas.print(area.x + 2, y, "⬡ procesando…", Style::new().fg(DIM));
        }
        return;
    }

    // Con workers activos: mostrar estado de cada worker
    for w in &state.workers.workers {
        if y >= area.bottom().saturating_sub(1) { break; }
        let (dot, dot_style) = match w.status {
            WorkerStatus::Running => ("●", Style::new().fg(GREEN).bold()),
            WorkerStatus::Done    => ("✓", Style::new().fg(GREEN)),
            WorkerStatus::Failed  => ("✗", Style::new().fg(RED)),
            WorkerStatus::Waiting => ("○", Style::new().fg(DIM)),
        };
        canvas.print(area.x + 2, y, dot, dot_style);
        let wcolor = worker_color(&w.name);
        canvas.print(area.x + 4, y, "⬡ ", Style::new().fg(wcolor));
        let max_name = 10usize;
        let name: String = w.name.chars().take(max_name).collect();
        canvas.print(area.x + 6, y, &name, Style::new().fg(wcolor).bold());
        if let Some(ref detail) = w.detail {
            let avail = area.w.saturating_sub(6 + name.len() as u16 + 2) as usize;
            let shown: String = detail.chars().take(avail).collect();
            canvas.print(area.x + 6 + name.len() as u16 + 1, y, &shown, Style::new().fg(SECONDARY));
        }
        y += 1;
    }
}

// ── Estado vacío ──────────────────────────────────────────────────────────────

fn render_empty(canvas: &mut Canvas, area: Rect, _state: &AppState) {
    let y = area.y + area.h / 3;
    canvas.print(area.x + 2, y, "Escribe tu primera tarea y presiona Enter", Style::new().fg(DIM));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn count_expanded_lines(state: &AppState, _width: usize) -> usize {
    let last_idx = state.history.entries.len().saturating_sub(1);
    let entry = &state.history.entries[last_idx];
    // Contar líneas del contenido + espacio para filemap
    let content_lines = entry.content.lines().count().max(1);
    let filemap_lines = state.filemap.entries.len().min(5);
    content_lines + filemap_lines + 3 // 3 = cabecera + gap + buffer
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

// Kept for external callers (controller.rs uses entry_at_y for click detection)
pub fn entry_at_y(_state: &AppState, _area: Rect, _y: u16) -> Option<usize> {
    None // click navigation deshabilitada en el nuevo diseño compacto
}
