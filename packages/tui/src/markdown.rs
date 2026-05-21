use crate::term::{Style, AMBER, DIM, GREEN, RED};

// ── Tipos de representación de texto estilizado ───────────────────────────────
//
// En ratatui existían `Span` (texto + estilo) y `Line` (Vec<Span>).
// Los reemplazamos con nuestros propios tipos sin dependencia externa.
//
// Por qué `type StyledLine = Vec<Segment>` y no `struct StyledLine(Vec<Segment>)`:
// ─────────────────────────────────────────────────────────────────────────────────
// Un *type alias* es transparente: `StyledLine` y `Vec<Segment>` son el mismo tipo.
// Podemos usar todos los métodos de Vec directamente (push, iter, len, etc.).
// Un newtype struct requeriría `.0` o impl Deref para acceder al Vec interno.
// Para un alias interno de conveniencia, el type alias es suficiente.

/// Un segmento de texto con estilo uniforme (equivalente a ratatui Span).
#[derive(Clone, Debug)]
pub struct Segment {
    pub text:  String,
    pub style: Style,
}

impl Segment {
    pub fn new(text: impl Into<String>, style: Style) -> Self {
        Self { text: text.into(), style }
    }

    pub fn plain(text: impl Into<String>) -> Self {
        Self { text: text.into(), style: Style::default() }
    }
}

/// Una línea de texto formada por segmentos estilizados (equivalente a ratatui Line).
pub type StyledLine = Vec<Segment>;

// ── ContentType y ThinkingMeta (sin cambios) ─────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContentType {
    Plain,
    Markdown,
    Thinking,
}

#[derive(Debug, Clone)]
pub struct ThinkingMeta {
    pub elapsed_secs: u32,
    pub token_count:  u32,
}

// ── Detección heurística ──────────────────────────────────────────────────────

pub fn is_likely_markdown(content: &str) -> bool {
    if content.contains("```") { return true; }
    for l in content.lines().take(5) {
        if l.starts_with("# ") || l.starts_with("## ") || l.starts_with("### ") {
            return true;
        }
    }
    if content.contains("**") {
        let first = content.find("**");
        let last  = content.rfind("**");
        if first.is_some() && last.is_some() && first != last { return true; }
    }
    let bullets = content.lines().take(10)
        .filter(|l| l.starts_with("- ") || l.starts_with("* ")).count();
    if bullets >= 2 { return true; }
    content.matches('`').count() >= 2
}

pub fn is_likely_diff(content: &str) -> bool {
    let markers = content.lines().take(10).filter(|l| {
        l.starts_with("diff ") || l.starts_with("--- ") ||
        l.starts_with("+++ ") || l.starts_with("@@")
    }).count();
    markers >= 2
}

// ── Renderizado a Vec<StyledLine> ────────────────────────────────────────────
//
// Las funciones siguientes convierten texto plano/markdown/diff/thinking en
// una lista de líneas estilizadas que los widgets pueden imprimir en el Canvas.
//
// `width` controla el wrapping (máximo de caracteres por línea).
// `prefix` es el indicador de rol ("▸ " para usuario, "  " para asistente, etc.)

pub fn render_content(
    content:      &str,
    content_type: &ContentType,
    thinking_meta: &Option<ThinkingMeta>,
    width:        usize,
    prefix:       &str,
    prefix_style: Style,
    indent:       &str,
) -> Vec<StyledLine> {
    match content_type {
        ContentType::Thinking  => render_thinking(content, thinking_meta, prefix, prefix_style, indent, width),
        ContentType::Markdown if is_likely_diff(content) => render_diff(content, prefix, prefix_style, indent, width),
        ContentType::Markdown  => render_markdown(content, prefix, prefix_style, indent, width),
        ContentType::Plain     => render_plain(content, prefix, prefix_style, indent, width),
    }
}

// ── render_thinking ───────────────────────────────────────────────────────────

fn render_thinking(
    content:  &str,
    meta:     &Option<ThinkingMeta>,
    prefix:   &str,
    prefix_style: Style,
    indent:   &str,
    width:    usize,
) -> Vec<StyledLine> {
    let mut lines: Vec<StyledLine> = Vec::new();
    let thinking_style = Style::new().fg(DIM);

    let header = if let Some(m) = meta {
        let tokens = if m.token_count > 0 { format!(" · {} tokens", fmt_tokens(m.token_count)) } else { String::new() };
        format!("Pensó por {}s{}", m.elapsed_secs, tokens)
    } else {
        "Pensando...".to_string()
    };

    lines.push(vec![
        Segment::new(prefix, prefix_style),
        Segment::new(header, thinking_style),
    ]);

    for (i, line) in content.lines().enumerate() {
        let avail = if i == 0 { width.saturating_sub(prefix.len()) } else { width.saturating_sub(indent.len()) }.max(10);
        for (j, wrapped) in textwrap::wrap(line, avail).into_iter().enumerate() {
            let pfx = if i == 0 && j == 0 { (prefix, prefix_style) } else { (indent, Style::default()) };
            lines.push(vec![
                Segment::new(pfx.0, pfx.1),
                Segment::new(wrapped.into_owned(), thinking_style),
            ]);
        }
    }

    lines.push(vec![]);
    lines
}

// ── render_markdown ───────────────────────────────────────────────────────────
//
// Implementación propia sin tui-markdown: reconoce los casos más comunes.
// No es un parser completo — cubre lo que los agentes suelen generar.

fn render_markdown(
    content: &str,
    prefix:  &str,
    prefix_style: Style,
    indent:  &str,
    width:   usize,
) -> Vec<StyledLine> {
    let mut lines: Vec<StyledLine> = Vec::new();
    let mut in_code_block = false;
    let code_style    = Style::new().fg(GREEN);
    let heading1_style = Style::new().fg(AMBER).bold();
    let heading2_style = Style::new().fg(AMBER).bold();
    let heading3_style = Style::new().fg(crate::term::CYAN).bold();
    let dim_style      = Style::new().fg(DIM);

    for (i, line) in content.lines().enumerate() {
        let is_first = i == 0;
        let pfx_seg  = |s: Style| Segment::new(if is_first { prefix } else { indent }, s);

        if line.starts_with("```") {
            in_code_block = !in_code_block;
            lines.push(vec![pfx_seg(dim_style), Segment::new(line, dim_style)]);
            continue;
        }

        if in_code_block {
            // Dentro de bloque de código: verde, sin wrap (respetamos la indentación)
            lines.push(vec![pfx_seg(code_style), Segment::new(line, code_style)]);
            continue;
        }

        // Headings
        let (text, style) = if let Some(t) = line.strip_prefix("### ") {
            (t, heading3_style)
        } else if let Some(t) = line.strip_prefix("## ") {
            (t, heading2_style)
        } else if let Some(t) = line.strip_prefix("# ") {
            (t, heading1_style)
        } else if line.starts_with("- ") || line.starts_with("* ") {
            // Bullet: reemplazar el marcador con ▸
            let t = line[2..].trim();
            let avail = width.saturating_sub(indent.len() + 2).max(10);
            for (j, wrapped) in textwrap::wrap(t, avail).into_iter().enumerate() {
                let bullet = if j == 0 { "▸ " } else { "  " };
                lines.push(vec![
                    pfx_seg(Style::default()),
                    Segment::new(bullet, Style::new().fg(AMBER)),
                    Segment::new(wrapped.into_owned(), Style::default()),
                ]);
            }
            continue;
        } else {
            (line, Style::default())
        };

        // Wrap con el estilo detectado
        let avail = width.saturating_sub(if is_first { prefix.len() } else { indent.len() }).max(10);
        for (j, wrapped) in textwrap::wrap(text, avail).into_iter().enumerate() {
            let p = if is_first && j == 0 { (prefix, prefix_style) } else { (indent, Style::default()) };
            lines.push(vec![Segment::new(p.0, p.1), Segment::new(wrapped.into_owned(), style)]);
        }
    }

    if lines.is_empty() {
        lines.push(vec![Segment::new(prefix, prefix_style)]);
    }
    lines.push(vec![]);
    lines
}

// ── render_diff ───────────────────────────────────────────────────────────────

fn render_diff(
    content: &str,
    prefix:  &str,
    prefix_style: Style,
    indent:  &str,
    width:   usize,
) -> Vec<StyledLine> {
    let mut lines: Vec<StyledLine> = Vec::new();

    for (i, line) in content.lines().enumerate() {
        let style = if line.starts_with('+') && !line.starts_with("+++") {
            Style::new().fg(GREEN)
        } else if line.starts_with('-') && !line.starts_with("---") {
            Style::new().fg(RED)
        } else if line.starts_with("@@") {
            Style::new().fg(DIM)
        } else if line.starts_with("diff ") || line.starts_with("--- ") || line.starts_with("+++ ") {
            Style::new().fg(AMBER)
        } else {
            Style::default()
        };

        let (pfx, pfx_style, avail) = if i == 0 {
            (prefix, prefix_style, width.saturating_sub(prefix.len()).max(10))
        } else {
            (indent, Style::default(), width.saturating_sub(indent.len()).max(10))
        };

        for (j, wrapped) in textwrap::wrap(line, avail).into_iter().enumerate() {
            let p = if j == 0 { (pfx, pfx_style) } else { (indent, Style::default()) };
            lines.push(vec![Segment::new(p.0, p.1), Segment::new(wrapped.into_owned(), style)]);
        }
    }

    lines.push(vec![]);
    lines
}

// ── render_plain ──────────────────────────────────────────────────────────────

fn render_plain(
    content: &str,
    prefix:  &str,
    prefix_style: Style,
    indent:  &str,
    width:   usize,
) -> Vec<StyledLine> {
    let mut lines: Vec<StyledLine> = Vec::new();

    if content.is_empty() {
        lines.push(vec![Segment::new(prefix, prefix_style)]);
        lines.push(vec![]);
        return lines;
    }

    for (i, line) in content.lines().enumerate() {
        let avail = if i == 0 {
            width.saturating_sub(prefix.len()).max(10)
        } else {
            width.saturating_sub(indent.len()).max(10)
        };

        for (j, wrapped) in textwrap::wrap(line, avail).into_iter().enumerate() {
            let p = if i == 0 && j == 0 { (prefix, prefix_style) } else { (indent, Style::default()) };
            lines.push(vec![Segment::new(p.0, p.1), Segment::new(wrapped.into_owned(), Style::default())]);
        }
    }

    lines.push(vec![]);
    lines
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn fmt_tokens(n: u32) -> String {
    if n >= 1_000_000 { format!("{:.1}M", n as f64 / 1_000_000.0) }
    else if n >= 1_000 { format!("{:.1}k", n as f64 / 1_000.0) }
    else { n.to_string() }
}
