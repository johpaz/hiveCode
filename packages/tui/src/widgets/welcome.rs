use crate::app::{AppState, ReplMode};
use crate::term::{
    Canvas, Color, Rect, Style,
    AMBER, AMBER_DIM, BLUE, CYAN, DIM, GREEN, PURPLE, RED, SECONDARY, WHITE,
};

// ── Bee ASCII art ─────────────────────────────────────────────────────────────
//
// La abeja tiene 12 líneas × 28 caracteres de ancho.
// Cada línea es una función que retorna los segmentos a dibujar en esa fila.
// Dividimos en segmentos porque cada parte tiene un color diferente.
//
// Por qué trabajamos con segmentos y no con un solo String con ANSI codes:
// ─────────────────────────────────────────────────────────────────────────────
// El Canvas sabe manejar colores por celda. Si pusiéramos ANSI codes dentro
// del string, el canvas los contaría como caracteres visibles y el alineamiento
// se rompería. En su lugar, dibujamos cada segmento con su estilo y el canvas
// se encarga de emitir las secuencias ANSI correctas en flush().

struct BeeSegment {
    text:  &'static str,
    color: Color,
    bold:  bool,
}

impl BeeSegment {
    const fn c(text: &'static str, color: Color) -> Self { Self { text, color, bold: false } }
    const fn b(text: &'static str, color: Color) -> Self { Self { text, color, bold: true  } }
}

/// Retorna los segmentos de la línea i de la abeja (0-11).
fn bee_row(i: usize) -> Vec<BeeSegment> {
    use BeeSegment::{c, b};
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
        // Abdomen (rayas ámbar/oscuras que se van estrechando)
        7  => vec![c("         ░░██████░░         ", AMBER)],
        8  => vec![c("         ░░░░░░░░░░         ", AMBER)],
        9  => vec![c("          ░░░░░░░░          ", AMBER)],
        10 => vec![c("           ░░░░░░           ", AMBER)],
        // Aguijón
        11 => vec![c("            ▼▼▼▼            ", AMBER)],
        _  => vec![],
    }
}

/// Texto lateral a la derecha de la abeja (líneas 3-6).
fn side_text(i: usize, version: &str) -> Option<(&'static str, String, Color)> {
    match i {
        3 => Some(("  hivecode", format!("  v{}", version), DIM)),
        4 => Some(("  Gateway de agentes de código", String::new(), DIM)),
        5 => Some(("  local-first · Bun runtime",    String::new(), DIM)),
        6 => Some(("  @johpaz",                       String::new(), DIM)),
        _ => None,
    }
}

/// Dibuja una fila de la abeja en el canvas en la posición (x, row).
fn draw_bee_row(canvas: &mut Canvas, i: usize, x: u16, row: u16, state: &AppState) {
    let segs = bee_row(i);
    let mut cx = x;
    for seg in &segs {
        let style = Style::new().fg(seg.color).bold();
        canvas.print(cx, row, seg.text, if seg.bold { style } else { Style::new().fg(seg.color) });
        cx += seg.text.chars().count() as u16;
    }

    // Texto lateral (versión, descripción, etc.)
    if let Some((main, extra, color)) = side_text(i, &state.version) {
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
    canvas.print(x,       row, "  │", Style::new().fg(AMBER));
    canvas.print(x + 3,   row, label, Style::new().fg(DIM));
    canvas.print(x + 3 + label.chars().count() as u16, row, value, Style::new().fg(vc));
}

fn mode_badge_text(mode: &ReplMode) -> (&'static str, Color, Color) {
    match mode {
        ReplMode::Plan     => (" PLAN ",       Color::Rgb(196, 181, 253), Color::Rgb(46, 26, 94)),
        ReplMode::Approval => (" APROBACIÓN ", Color::Rgb(252, 211, 77),  Color::Rgb(69, 26, 3)),
        ReplMode::Auto     => (" AUTO ",       Color::Rgb(110, 231, 183), Color::Rgb(6, 78, 59)),
    }
}

fn draw_mode_row(canvas: &mut Canvas, x: u16, row: u16, mode: &ReplMode) {
    canvas.print(x,      row, "  │", Style::new().fg(AMBER));
    canvas.print(x + 3,  row, "  Modo      ", Style::new().fg(DIM));
    let (label, fg, bg) = mode_badge_text(mode);
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

        let role_colors: &[(&str, Color)] = &[
            ("bee",    AMBER),
            ("arch",   PURPLE),
            ("back",   BLUE),
            ("front",  CYAN),
            ("sec",    RED),
            ("test",   GREEN),
            ("devops", AMBER_DIM),
        ];

        for (idx, worker) in workers.iter().enumerate() {
            let color = role_colors.iter()
                .find(|(k, _)| worker.contains(k))
                .map(|(_, c)| *c)
                .unwrap_or(DIM);
            canvas.print(cx, row, worker, Style::new().fg(color));
            cx += worker.chars().count() as u16;
            if idx + 1 < count {
                canvas.print(cx, row, " · ", Style::new().fg(DIM));
                cx += 3;
            }
        }
    }
}

// ── Punto de entrada del widget ───────────────────────────────────────────────

pub fn draw(canvas: &mut Canvas, state: &AppState, rect: Rect) {
    // Centrar verticalmente si el terminal es más alto que el contenido (~24 líneas)
    let content_h: u16 = 24;
    let top_pad = rect.h.saturating_sub(content_h) / 2;
    let x   = rect.x;
    let mut row = rect.y + top_pad;

    // ── Abeja ASCII (12 líneas) ───────────────────────────────────────────────
    for i in 0..12 {
        if row >= rect.bottom() { break; }
        draw_bee_row(canvas, i, x, row, state);
        row += 1;
    }

    if row < rect.bottom() { row += 1; } // línea vacía

    // ── Separador ─────────────────────────────────────────────────────────────
    if row < rect.bottom() {
        draw_sep(canvas, x, row);
        row += 1;
    }

    // ── Información ───────────────────────────────────────────────────────────
    if state.provider.is_empty() {
        // Sin provider configurado
        if row < rect.bottom() {
            canvas.print(x, row, "  │", Style::new().fg(AMBER));
            canvas.print(x + 3, row, "  Sin provider configurado", Style::new().fg(RED));
            row += 1;
        }
        if row < rect.bottom() {
            canvas.print(x, row, "  │", Style::new().fg(AMBER));
            canvas.print(x + 3, row, "  ▸ Escribe  ", Style::new().fg(DIM));
            canvas.print(x + 16, row, "/provider", Style::new().fg(AMBER));
            canvas.print(x + 25, row, "  para configurar un LLM", Style::new().fg(DIM));
            row += 1;
        }
        if row < rect.bottom() {
            canvas.print(x, row, "  │", Style::new().fg(AMBER));
            canvas.print(x + 3, row, "  anthropic · openai · groq · gemini · ollama",
                Style::new().fg(DIM));
            row += 1;
        }
    } else {
        // Modo
        if row < rect.bottom() {
            draw_mode_row(canvas, x, row, &state.mode);
            row += 1;
        }

        // Directorio
        if row < rect.bottom() {
            let path = &state.project_path;
            let display = std::env::var("HOME")
                .ok()
                .and_then(|h| path.strip_prefix(&h).map(|s| format!("~{s}")))
                .unwrap_or_else(|| path.clone());
            draw_bar_label(canvas, x, row, "  Directory ", &display, SECONDARY);
            row += 1;
        }

        // Sesión
        if row < rect.bottom() {
            let sid = if state.session_id.is_empty() { "—".to_string() } else { state.session_id.clone() };
            draw_bar_label(canvas, x, row, "  Session   ", &sid, SECONDARY);
            row += 1;
        }

        // Provider
        if row < rect.bottom() {
            let prov = if state.model.is_empty() {
                state.provider.clone()
            } else {
                format!("{}  ·  {}", state.provider, state.model)
            };
            draw_bar_label(canvas, x, row, "  Provider  ", &prov, GREEN);
            row += 1;
        }

        // Workers
        if row < rect.bottom() {
            draw_workers_row(canvas, x, row, &state.workers);
            row += 1;
        }

        // Tareas / tokens
        if row < rect.bottom() {
            canvas.print(x,     row, "  │", Style::new().fg(AMBER));
            canvas.print(x + 3, row, "  Tareas    ", Style::new().fg(DIM));
            let tasks = state.task_count.to_string();
            canvas.print(x + 15, row, &tasks, Style::new().fg(SECONDARY));
            canvas.print(x + 15 + tasks.len() as u16, row, "  ·  tokens ", Style::new().fg(DIM));
            canvas.print(x + 15 + tasks.len() as u16 + 12, row, &state.fmt_tokens(), Style::new().fg(DIM));
            row += 1;
        }
    }

    // ── Separador inferior ────────────────────────────────────────────────────
    if row < rect.bottom() {
        draw_sep(canvas, x, row);
        row += 1;
    }

    // ── Hint de comandos ─────────────────────────────────────────────────────
    if row < rect.bottom() {
        canvas.print(x,     row, "  │", Style::new().fg(AMBER));
        canvas.print(x + 3, row, "  Escribe / para ver todos los comandos disponibles",
            Style::new().fg(DIM));
    }
}
