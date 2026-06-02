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
    pub text: String,
    pub style: Style,
    pub indent: u16,
}

impl MarkdownLine {
    pub fn new(text: impl Into<String>, style: Style, indent: u16) -> Self {
        Self { text: text.into(), style, indent }
    }
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
        canvas.print(area.x + line.indent, area.y + idx as u16, &line.text, line.style);
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
            push_wrapped(&mut out, text, width, Style::new().fg(AMBER_DIM).bold(), 0);
        } else if let Some(text) = trimmed.strip_prefix("## ") {
            push_wrapped(&mut out, text, width, Style::new().fg(AMBER).bold(), 0);
        } else if let Some(text) = trimmed.strip_prefix("# ") {
            push_wrapped(&mut out, text, width, Style::new().fg(AMBER_BRIGHT).bold(), 0);
        } else if let Some(text) = trimmed.strip_prefix("> ") {
            push_wrapped(&mut out, text, width.saturating_sub(2), Style::new().fg(DIM), 2);
        } else if let Some(text) = trimmed.strip_prefix("- ").or_else(|| trimmed.strip_prefix("* ")) {
            push_wrapped(&mut out, &format!("• {text}"), width.saturating_sub(2), Style::new().fg(SECONDARY), 1);
        } else if is_numbered_list(trimmed) {
            push_wrapped(&mut out, trimmed, width.saturating_sub(2), Style::new().fg(SECONDARY), 1);
        } else {
            push_wrapped(&mut out, trimmed, width, Style::new().fg(WHITE), 0);
        }
    }

    flush_table(&mut out, &mut table_rows, width);
    if out.is_empty() {
        out.push(MarkdownLine::new("", Style::new().fg(WHITE), 0));
    }
    out
}

fn push_wrapped(out: &mut Vec<MarkdownLine>, text: &str, width: usize, style: Style, indent: u16) {
    for line in wrap_cells(text, width.max(1), Overflow::WordWrap) {
        out.push(MarkdownLine::new(line, style, indent));
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
        .map(|cell| cell.trim().to_string())
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
}
