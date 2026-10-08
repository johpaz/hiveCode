use crate::{
    term::{Canvas, Rect, Style, AMBER, AMBER_BRIGHT, AMBER_DIM, BG_ELEVATED, DIM, GREEN, SECONDARY, WHITE},
    ui::{
        scroll::{render_vertical_scrollbar, ScrollbarState},
        table::{render_data_table, DataTable, TableAlign, TableCell, TableColumn, TableState},
        text::{wrap_cells, Overflow},
    },
};

#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownLine {
    /// Texto visible, sin marcadores de markdown inline.
    pub text: String,
    pub style: Style,
    pub indent: u16,
    /// Tramos con estilo propio (negrita, código). Vacío cuando toda la línea
    /// usa `style`; si no, la concatenación de los tramos es `text`.
    pub spans: Vec<(String, Style)>,
}

impl MarkdownLine {
    pub fn new(text: impl Into<String>, style: Style, indent: u16) -> Self {
        Self { text: text.into(), style, indent, spans: Vec::new() }
    }
}

/// Pinta una línea con sus tramos. Devuelve la columna final.
pub fn print_line(canvas: &mut Canvas, x: u16, y: u16, line: &MarkdownLine) -> u16 {
    if line.spans.is_empty() {
        canvas.print(x, y, &line.text, line.style);
        return x.saturating_add(crate::ui::text::cell_width(&line.text) as u16);
    }
    let mut cx = x;
    for (text, style) in &line.spans {
        canvas.print(cx, y, text, *style);
        cx = cx.saturating_add(crate::ui::text::cell_width(text) as u16);
    }
    cx
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MarkdownView {
    pub scroll: usize,
}

pub fn render_markdown(canvas: &mut Canvas, area: Rect, content: &str, view: MarkdownView) {
    if area.w == 0 || area.h == 0 {
        return;
    }

    let lines = build_markdown_lines(content, area.w.saturating_sub(2).max(1) as usize);
    let body_h = area.h as usize;
    let max_scroll = lines.len().saturating_sub(body_h);
    let scroll = view.scroll.min(max_scroll);

    for (idx, line) in lines.iter().skip(scroll).take(body_h).enumerate() {
        print_line(canvas, area.x + line.indent, area.y + idx as u16, line);
    }

    if max_scroll > 0 {
        render_vertical_scrollbar(
            canvas,
            Rect::new(area.right().saturating_sub(1), area.y, 1, area.h),
            ScrollbarState::new(lines.len(), body_h, scroll),
            Style::new().fg(DIM),
            Style::new().fg(DIM),
        );
    }
}

fn strip_think_blocks(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains("<think>") {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        rest = &rest[start + 7..];
        if let Some(end) = rest.find("</think>") {
            rest = &rest[end + 8..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

pub fn build_markdown_lines(content: &str, width: usize) -> Vec<MarkdownLine> {
    let content = strip_think_blocks(content);
    let content = content.as_ref();
    let mut out = Vec::new();
    let mut in_code = false;
    let mut table_rows: Vec<Vec<String>> = Vec::new();

    for raw in content.lines() {
        let line = raw.trim_end();

        if line.trim_start().starts_with("```") {
            flush_table(&mut out, &mut table_rows, width);
            in_code = !in_code;
            if in_code {
                let lang = line.trim_start_matches('`').trim();
                if !lang.is_empty() {
                    out.push(MarkdownLine::new(format!("code: {lang}"), Style::new().fg(DIM), 0));
                }
            }
            continue;
        }

        if in_code {
            flush_table(&mut out, &mut table_rows, width);
            for wrapped in wrap_cells(line, width.saturating_sub(1), Overflow::Wrap) {
                out.push(MarkdownLine::new(wrapped, Style::new().fg(GREEN).bg(BG_ELEVATED), 1));
            }
            continue;
        }

        if looks_like_table_row(line) {
            let row = parse_table_row(line);
            if !is_table_separator(&row) {
                table_rows.push(row);
            }
            continue;
        }
        flush_table(&mut out, &mut table_rows, width);

        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            out.push(MarkdownLine::new("", Style::new().fg(SECONDARY), 0));
        } else if let Some(text) = trimmed.strip_prefix("### ") {
            push_inline(&mut out, "", text, width, Style::new().fg(AMBER_DIM).bold(), 0);
        } else if let Some(text) = trimmed.strip_prefix("## ") {
            push_inline(&mut out, "", text, width, Style::new().fg(AMBER).bold(), 0);
        } else if let Some(text) = trimmed.strip_prefix("# ") {
            push_inline(&mut out, "", text, width, Style::new().fg(AMBER_BRIGHT).bold(), 0);
        } else if let Some(text) = trimmed.strip_prefix("> ") {
            push_inline(&mut out, "", text, width.saturating_sub(2), Style::new().fg(DIM), 2);
        } else if let Some(text) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            push_inline(&mut out, "• ", text, width.saturating_sub(2), Style::new().fg(SECONDARY), 1);
        } else if is_numbered_list(trimmed) {
            push_inline(&mut out, "", trimmed, width.saturating_sub(2), Style::new().fg(SECONDARY), 1);
        } else {
            push_inline(&mut out, "", trimmed, width, Style::new().fg(WHITE), 0);
        }
    }

    flush_table(&mut out, &mut table_rows, width);
    if out.is_empty() {
        out.push(MarkdownLine::new("", Style::new().fg(WHITE), 0));
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Inline {
    Plain,
    Bold,
    Code,
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    (from..chars.len()).find(|&i| chars[i] == target)
}

fn find_bold_close(chars: &[char], from: usize) -> Option<usize> {
    (from..chars.len().saturating_sub(1)).find(|&i| chars[i] == '*' && chars[i + 1] == '*')
}

/// Quita los marcadores de markdown inline y anota qué estilo lleva cada
/// carácter resultante. Cubre `**negrita**`, `` `código` ``, `*cursiva*` (sin
/// estilo propio: la terminal no la pinta, pero tampoco se ven los `*`) y
/// `[texto](url)`. Un marcador sin pareja se deja tal cual.
fn parse_inline(text: &str) -> (String, Vec<Inline>) {
    let chars: Vec<char> = text.chars().collect();
    let mut plain = String::with_capacity(text.len());
    let mut kinds: Vec<Inline> = Vec::with_capacity(chars.len());
    let mut bold = false;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        let base = if bold { Inline::Bold } else { Inline::Plain };

        if c == '`' {
            if let Some(end) = find_char(&chars, i + 1, '`').filter(|&e| e > i + 1) {
                for &ch in &chars[i + 1..end] {
                    plain.push(ch);
                    kinds.push(Inline::Code);
                }
                i = end + 1;
                continue;
            }
        }
        if c == '*' && chars.get(i + 1) == Some(&'*') && (bold || find_bold_close(&chars, i + 2).is_some()) {
            bold = !bold;
            i += 2;
            continue;
        }
        if c == '*' && chars.get(i + 1).is_some_and(|n| !n.is_whitespace() && *n != '*') {
            let close = (i + 2..chars.len()).find(|&j| {
                chars[j] == '*' && !chars[j - 1].is_whitespace() && chars.get(j + 1) != Some(&'*')
            });
            if let Some(end) = close {
                for &ch in &chars[i + 1..end] {
                    plain.push(ch);
                    kinds.push(base);
                }
                i = end + 1;
                continue;
            }
        }
        if c == '[' {
            if let Some(close) = find_char(&chars, i + 1, ']').filter(|&c| chars.get(c + 1) == Some(&'(')) {
                if let Some(paren) = find_char(&chars, close + 2, ')') {
                    let label: String = chars[i + 1..close].iter().collect();
                    let url: String = chars[close + 2..paren].iter().collect();
                    let shown = if url.is_empty() || label == url { label } else { format!("{label} ({url})") };
                    for ch in shown.chars() {
                        plain.push(ch);
                        kinds.push(base);
                    }
                    i = paren + 1;
                    continue;
                }
            }
        }
        plain.push(c);
        kinds.push(base);
        i += 1;
    }
    (plain, kinds)
}

/// El texto sin marcadores de markdown inline. Para vistas de una línea
/// (previews, razonamiento) que no pintan estilos por tramo.
pub fn strip_inline(text: &str) -> String {
    parse_inline(text).0
}

fn push_inline(out: &mut Vec<MarkdownLine>, prefix: &str, text: &str, width: usize, style: Style, indent: u16) {
    let (plain, kinds) = parse_inline(text);
    let source: Vec<char> = plain.chars().collect();
    let styled = kinds.iter().any(|k| *k != Inline::Plain);
    let mut cursor = 0usize;

    let full = format!("{prefix}{plain}");
    for line in wrap_cells(&full, width.max(1), Overflow::WordWrap) {
        let mut md = MarkdownLine::new(line.clone(), style, indent);
        if styled {
            let mut spans: Vec<(String, Style)> = Vec::new();
            for ch in line.chars() {
                // Salta los espacios que el wrap descartó; si el carácter no viene
                // del texto (el prefijo `• `), se queda con el estilo base.
                let mut probe = cursor;
                while probe < source.len() && source[probe] != ch && source[probe].is_whitespace() {
                    probe += 1;
                }
                let kind = if probe < source.len() && source[probe] == ch {
                    cursor = probe + 1;
                    kinds[probe]
                } else {
                    Inline::Plain
                };
                let span_style = match kind {
                    Inline::Plain => style,
                    Inline::Bold => style.bold(),
                    Inline::Code => Style::new().fg(GREEN),
                };
                match spans.last_mut() {
                    Some((text, last)) if *last == span_style => text.push(ch),
                    _ => spans.push((ch.to_string(), span_style)),
                }
            }
            md.spans = spans;
        }
        out.push(md);
    }
}

fn looks_like_table_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.matches('|').count() >= 2
}

fn parse_table_row(line: &str) -> Vec<String> {
    line.trim()
        .trim_matches('|')
        .split('|')
        .map(|cell| strip_inline(cell.trim()))
        .collect()
}

fn is_table_separator(row: &[String]) -> bool {
    !row.is_empty()
        && row.iter().all(|cell| {
            let trimmed = cell.trim();
            !trimmed.is_empty()
                && trimmed.chars().all(|ch| ch == '-' || ch == ':' || ch == ' ')
        })
}

fn flush_table(out: &mut Vec<MarkdownLine>, table_rows: &mut Vec<Vec<String>>, width: usize) {
    if table_rows.is_empty() {
        return;
    }

    let column_count = table_rows.iter().map(Vec::len).max().unwrap_or(0);
    if column_count == 0 {
        table_rows.clear();
        return;
    }

    let col_width = ((width.saturating_sub(column_count.saturating_sub(1))) / column_count).max(3) as u16;
    let columns: Vec<TableColumn> = (0..column_count)
        .map(|idx| TableColumn::fixed(format!("c{idx}"), col_width, TableAlign::Left))
        .collect();
    let rows: Vec<Vec<TableCell>> = table_rows
        .iter()
        .enumerate()
        .map(|(row_idx, row)| {
            (0..column_count)
                .map(|idx| {
                    let style = if row_idx == 0 {
                        Style::new().fg(AMBER_DIM).bold()
                    } else {
                        Style::new().fg(SECONDARY)
                    };
                    TableCell::new(row.get(idx).cloned().unwrap_or_default(), style)
                })
                .collect()
        })
        .collect();

    let height = rows.len() as u16;
    let mut canvas = Canvas::new(width as u16, height);
    render_data_table(
        &mut canvas,
        Rect::new(0, 0, width as u16, height),
        &columns,
        &rows,
        TableState::default(),
        &DataTable { show_header: false, zebra: false, ..DataTable::default() },
    );

    for row in canvas.to_text_rows() {
        out.push(MarkdownLine::new(row.trim_end().to_string(), Style::new().fg(SECONDARY), 0));
    }
    table_rows.clear();
}

fn is_numbered_list(line: &str) -> bool {
    let Some((digits, rest)) = line.split_once(". ") else {
        return false;
    };
    !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit()) && !rest.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_headings_lists_code_and_tables() {
        let lines = build_markdown_lines(
            "# Title\n\n- item\n\n```ts\nconst x = 1\n```\n\n| A | B |\n|---|---|\n| one | two |",
            30,
        );

        assert!(lines.iter().any(|line| line.text == "Title"));
        assert!(lines.iter().any(|line| line.text.contains("• item")));
        assert!(lines.iter().any(|line| line.text.contains("const x")));
        assert!(lines.iter().any(|line| line.text.contains("one")));
        assert!(lines.iter().all(|line| crate::ui::text::cell_width(&line.text) <= 30));
    }

    fn flat(lines: &[MarkdownLine]) -> String {
        lines.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn inline_bold_loses_its_markers_and_keeps_its_style() {
        let lines = build_markdown_lines("¡Hola! Soy **BEE**, tu Lead.", 60);
        assert_eq!(lines[0].text, "¡Hola! Soy BEE, tu Lead.");
        let bold: Vec<_> = lines[0].spans.iter().filter(|(_, st)| st.bold).collect();
        assert_eq!(bold.len(), 1);
        assert_eq!(bold[0].0, "BEE");
        let joined: String = lines[0].spans.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(joined, lines[0].text);
    }

    #[test]
    fn inline_code_links_and_italic() {
        let lines = build_markdown_lines("usa `bun test` y *mira* [docs](https://x.dev)", 80);
        assert_eq!(lines[0].text, "usa bun test y mira docs (https://x.dev)");
        assert!(lines[0].spans.iter().any(|(t, st)| t == "bun test" && st.fg == GREEN));
    }

    #[test]
    fn unpaired_markers_are_left_alone() {
        assert_eq!(strip_inline("2 * 3 * 4"), "2 * 3 * 4");
        assert_eq!(strip_inline("a ** b"), "a ** b");
        assert_eq!(strip_inline("un ` suelto"), "un ` suelto");
    }

    #[test]
    fn bold_survives_wrapping_and_bullets() {
        let lines = build_markdown_lines("- uno **dos tres cuatro** cinco", 14);
        assert!(flat(&lines).contains("• uno"));
        assert!(!flat(&lines).contains("**"));
        for l in lines.iter().filter(|l| !l.spans.is_empty()) {
            let joined: String = l.spans.iter().map(|(t, _)| t.as_str()).collect();
            assert_eq!(joined, l.text);
        }
        assert!(lines.iter().flat_map(|l| &l.spans).any(|(t, st)| st.bold && t.contains("dos")));
    }
}
