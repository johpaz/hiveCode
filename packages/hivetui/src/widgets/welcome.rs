use crate::{
    state::{AppState, ReplMode},
    term::{
        Canvas, Color, Rect, Style,
        AMBER, AMBER_DIM, BLUE, CYAN, DIM, GREEN, PURPLE, RED, SECONDARY, WHITE,
    },
};

// ── Bee ASCII art ─────────────────────────────────────────────────────────────
//
// 12 líneas × 28 caracteres de ancho, portado desde packages/tui.
// Cada fila se divide en segmentos porque cada parte tiene un color diferente.

struct BeeSegment {
    text:  &'static str,
    color: Color,
    bold:  bool,
}

impl BeeSegment {
    const fn c(text: &'static str, color: Color) -> Self { Self { text, color, bold: false } }
    const fn b(text: &'static str, color: Color) -> Self { Self { text, color, bold: true  } }
}

fn bee_row(i: usize) -> Vec<BeeSegment> {
    let c = BeeSegment::c;
    let b = BeeSegment::b;
    match i {
        // Antenas
        0 => vec![c("        \\          /        ", DIM)],
        1 => vec![c("         \\        /         ", DIM)],
        2 => vec![c("          \\      /          ", DIM)],
        // Cabeza
        3 => vec![
            c("          ",  DIM),
            c("(",           AMBER),
            b(" o  o ",      WHITE),
            c(")",           AMBER),
            c("          ",  DIM),
        ],
        // Alas + tórax
        4 => vec![
            c("   ", DIM),
            c("▒▒▒▒▒",        CYAN),
            c(" ░░░░░░░░░░ ", AMBER),
            c("▒▒▒▒▒",        CYAN),
            c("   ", DIM),
        ],
        5 => vec![
            c("   ", DIM),
            c("▒▒▒▒▒",        CYAN),
            c(" ░░██████░░ ", AMBER),
            c("▒▒▒▒▒",        CYAN),
            c("   ", DIM),
        ],
        6 => vec![
            c("   ", DIM),
            c("▒▒▒▒▒",        CYAN),
            c(" ░░░░░░░░░░ ", AMBER),
            c("▒▒▒▒▒",        CYAN),
            c("   ", DIM),
        ],
        // Abdomen (se va estrechando)
        7  => vec![c("         ░░██████░░         ", AMBER)],
        8  => vec![c("         ░░░░░░░░░░         ", AMBER)],
        9  => vec![c("          ░░░░░░░░          ", AMBER)],
        10 => vec![c("           ░░░░░░           ", AMBER)],
        // Aguijón
        11 => vec![c("            ▼▼▼▼            ", AMBER)],
        _  => vec![],
    }
}

/// Texto que se imprime a la derecha de la abeja en líneas 3-6.
fn side_text(i: usize, version: &str) -> Option<(&'static str, String, Color)> {
    match i {
        3 => Some(("  hivecode", format!("  v{}", version), DIM)),
        4 => Some(("  Gateway de agentes de código", String::new(), DIM)),
        5 => Some(("  local-first · Bun runtime",    String::new(), DIM)),
        6 => Some(("  @johpaz",                       String::new(), DIM)),
        _ => None,
    }
}

fn draw_bee_row(canvas: &mut Canvas, i: usize, x: u16, row: u16, version: &str) {
    let segs = bee_row(i);
    let mut cx = x;
    for seg in &segs {
        let style = if seg.bold {
            Style::new().fg(seg.color).bold()
        } else {
            Style::new().fg(seg.color)
        };
        canvas.print(cx, row, seg.text, style);
        cx += seg.text.chars().count() as u16;
    }
    if let Some((main, extra, color)) = side_text(i, version) {
        canvas.print(cx, row, main, Style::new().fg(WHITE).bold());
        cx += main.chars().count() as u16;
        if !extra.is_empty() {
            canvas.print(cx, row, &extra, Style::new().fg(color));
        }
    }
}

// ── Elementos de información ──────────────────────────────────────────────────

fn draw_sep(canvas: &mut Canvas, x: u16, row: u16) {
    canvas.print(x, row, "  ─────────────────────────────────────────────",
        Style::new().fg(DIM));
}

fn draw_bar_label(canvas: &mut Canvas, x: u16, row: u16, label: &str, value: &str, vc: Color) {
    canvas.print(x,     row, "  │", Style::new().fg(AMBER));
    canvas.print(x + 3, row, label, Style::new().fg(DIM));
    canvas.print(x + 3 + label.chars().count() as u16, row, value, Style::new().fg(vc));
}

fn mode_badge(mode: &ReplMode) -> (&'static str, Color, Color) {
    match mode {
        ReplMode::Plan     => (" PLAN ",       Color::Rgb { r: 196, g: 181, b: 253 }, Color::Rgb { r: 46, g: 26, b: 94 }),
        ReplMode::Approval => (" APROBACIÓN ", Color::Rgb { r: 252, g: 211, b: 77 }, Color::Rgb { r: 69, g: 26, b: 3 }),
        ReplMode::Auto     => (" AUTO ",       Color::Rgb { r: 110, g: 231, b: 183 }, Color::Rgb { r: 6, g: 78, b: 59 }),
    }
}

fn draw_mode_row(canvas: &mut Canvas, x: u16, row: u16, mode: &ReplMode) {
    canvas.print(x,     row, "  │", Style::new().fg(AMBER));
    canvas.print(x + 3, row, "  Modo      ", Style::new().fg(DIM));
    let (label, fg, bg) = mode_badge(mode);
    let badge_x = x + 3 + 12;
    canvas.print(badge_x, row, label, Style::new().fg(fg).bg(bg).bold());
    let after = badge_x + label.chars().count() as u16;
    canvas.print(after, row, "  shift+tab para cambiar", Style::new().fg(DIM));
}

fn draw_workers_row(canvas: &mut Canvas, x: u16, row: u16, workers: &[String]) {
    let count = workers.len();
    let count_color = if count >= 7 { GREEN } else { RED };
    canvas.print(x,     row, "  │", Style::new().fg(AMBER));
    canvas.print(x + 3, row, "  Workers   ", Style::new().fg(DIM));
    let after = x + 3 + 12;
    let count_text = format!("{} activos", count);
    canvas.print(after, row, &count_text, Style::new().fg(count_color));

    if count > 0 {
        let mut cx = after + count_text.chars().count() as u16;
        canvas.print(cx, row, "  ·  ", Style::new().fg(DIM));
        cx += 5;
        for (idx, worker) in workers.iter().enumerate() {
            let color = worker_color(worker);
            canvas.print(cx, row, worker, Style::new().fg(color));
            cx += worker.chars().count() as u16;
            if idx + 1 < count {
                canvas.print(cx, row, " · ", Style::new().fg(DIM));
                cx += 3;
            }
        }
    }
}

/// Asigna color por nombre de worker (coincidencia de subcadena).
pub fn worker_color(name: &str) -> Color {
    const ROLES: &[(&str, Color)] = &[
        ("bee",    AMBER),
        ("arch",   PURPLE),
        ("back",   BLUE),
        ("front",  CYAN),
        ("sec",    RED),
        ("test",   GREEN),
        ("devops", AMBER_DIM),
    ];
    ROLES.iter()
        .find(|(k, _)| name.contains(k))
        .map(|(_, c)| *c)
        .unwrap_or(SECONDARY)
}

// ── Punto de entrada ──────────────────────────────────────────────────────────

pub fn render(canvas: &mut Canvas, area: Rect, state: &AppState) {
    let content_h: u16 = 24;
    let top_pad = area.h.saturating_sub(content_h) / 2;
    let x   = area.x;
    let mut row = area.y + top_pad;

    let session = &state.session;

    // Abeja (12 líneas)
    for i in 0..12usize {
        if row >= area.bottom() { break; }
        draw_bee_row(canvas, i, x, row, &session.version);
        row += 1;
    }

    if row < area.bottom() { row += 1; }

    // Separador
    if row < area.bottom() {
        draw_sep(canvas, x, row);
        row += 1;
    }

    // Información
    if session.provider.is_empty() {
        if row < area.bottom() {
            canvas.print(x,     row, "  │", Style::new().fg(AMBER));
            canvas.print(x + 3, row, "  Sin provider configurado", Style::new().fg(RED));
            row += 1;
        }
        if row < area.bottom() {
            canvas.print(x,      row, "  │", Style::new().fg(AMBER));
            canvas.print(x + 3,  row, "  ▸ Escribe  ", Style::new().fg(DIM));
            canvas.print(x + 16, row, "/provider", Style::new().fg(AMBER));
            canvas.print(x + 25, row, "  para configurar un LLM", Style::new().fg(DIM));
            row += 1;
        }
        if row < area.bottom() {
            canvas.print(x,     row, "  │", Style::new().fg(AMBER));
            canvas.print(x + 3, row, "  anthropic · openai · groq · gemini · ollama",
                Style::new().fg(DIM));
            row += 1;
        }
    } else {
        if row < area.bottom() {
            draw_mode_row(canvas, x, row, &session.mode);
            row += 1;
        }
        if row < area.bottom() {
            let path = &session.project_path;
            let display = std::env::var("HOME")
                .ok()
                .and_then(|h| path.strip_prefix(&h).map(|s| format!("~{s}")))
                .unwrap_or_else(|| path.clone());
            draw_bar_label(canvas, x, row, "  Directory ", &display, SECONDARY);
            row += 1;
        }
        if row < area.bottom() {
            let sid = if session.session_id.is_empty() {
                "—".to_string()
            } else {
                session.session_id.clone()
            };
            draw_bar_label(canvas, x, row, "  Session   ", &sid, SECONDARY);
            row += 1;
        }
        if row < area.bottom() {
            let prov = if session.model.is_empty() {
                session.provider.clone()
            } else {
                format!("{}  ·  {}", session.provider, session.model)
            };
            draw_bar_label(canvas, x, row, "  Provider  ", &prov, GREEN);
            row += 1;
        }
        if row < area.bottom() {
            draw_workers_row(canvas, x, row, &session.workers);
            row += 1;
        }
        if row < area.bottom() {
            canvas.print(x,     row, "  │", Style::new().fg(AMBER));
            canvas.print(x + 3, row, "  Tareas    ", Style::new().fg(DIM));
            let tasks = session.task_count.to_string();
            canvas.print(x + 15, row, &tasks, Style::new().fg(SECONDARY));
            canvas.print(x + 15 + tasks.len() as u16, row, "  ·  tokens ", Style::new().fg(DIM));
            let tok_str = fmt_tokens(session.token_count);
            canvas.print(x + 15 + tasks.len() as u16 + 12, row, &tok_str, Style::new().fg(DIM));
            row += 1;
        }
    }

    // Separador inferior
    if row < area.bottom() {
        draw_sep(canvas, x, row);
        row += 1;
    }

    // Hint de comandos
    if row < area.bottom() {
        canvas.print(x,     row, "  │", Style::new().fg(AMBER));
        canvas.print(x + 3, row, "  Escribe / para ver todos los comandos disponibles",
            Style::new().fg(DIM));
    }
}

fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}
