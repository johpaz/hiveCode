use unicode_width::UnicodeWidthChar;

use crate::term::{
    Canvas, Color, Rect, Style, AMBER_BRIGHT, BLUE, CYAN, LAVENDER, PINK, PURPLE, SECONDARY,
    YELLOW,
};

#[derive(Clone, Debug, PartialEq)]
pub struct StyledLine {
    pub text: String,
    pub style: Style,
    pub indent: u16,
}

impl StyledLine {
    pub fn new(text: impl Into<String>, style: Style, indent: u16) -> Self {
        Self { text: text.into(), style, indent }
    }

    pub fn blank(style: Style) -> Self {
        Self::new("", style, 0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Align {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ColumnWidth {
    Fixed(u16),
    Fill,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TableColumn {
    pub width: ColumnWidth,
    pub align: Align,
}

impl TableColumn {
    pub fn fixed(width: u16, align: Align) -> Self {
        Self { width: ColumnWidth::Fixed(width), align }
    }

    pub fn fill(align: Align) -> Self {
        Self { width: ColumnWidth::Fill, align }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TableCell {
    pub text: String,
    pub style: Style,
}

impl TableCell {
    pub fn new(text: impl Into<String>, style: Style) -> Self {
        Self { text: text.into(), style }
    }
}

pub fn text_width(text: &str) -> usize {
    text.chars()
        .map(|ch| UnicodeWidthChar::width(ch).unwrap_or(1).max(1))
        .sum()
}

pub fn truncate_cells(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }

    let mut out = String::new();
    let mut width = 0usize;
    for ch in text.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(1).max(1);
        if width + ch_width > max_width {
            break;
        }
        out.push(ch);
        width += ch_width;
    }
    out
}

pub fn push_wrapped_lines(
    lines: &mut Vec<StyledLine>,
    text: &str,
    width: usize,
    style: Style,
    indent: u16,
) {
    let width = width.max(1);
    let mut remaining = text.trim().to_string();
    if remaining.is_empty() {
        lines.push(StyledLine::blank(style));
        return;
    }

    while !remaining.is_empty() {
        let chars: Vec<char> = remaining.chars().collect();
        let mut hard_end = 0usize;
        let mut cells = 0usize;

        while hard_end < chars.len() {
            let char_width = UnicodeWidthChar::width(chars[hard_end]).unwrap_or(1).max(1);
            if hard_end > 0 && cells + char_width > width {
                break;
            }
            cells += char_width;
            hard_end += 1;
        }

        if hard_end == chars.len() {
            lines.push(StyledLine::new(remaining, style, indent));
            break;
        }

        let split = chars[..hard_end]
            .iter()
            .rposition(|ch| ch.is_whitespace())
            .filter(|idx| *idx > 0)
            .unwrap_or(hard_end);
        let text: String = chars[..split].iter().collect();
        lines.push(StyledLine::new(text.trim_end(), style, indent));
        remaining = chars[split..].iter().collect::<String>().trim_start().to_string();
    }
}

pub fn render_scrollbar(
    canvas: &mut Canvas,
    area: Rect,
    total: usize,
    start: usize,
    thumb_style: Style,
    track_style: Style,
) {
    if area.h == 0 || total == 0 {
        return;
    }

    let visible = area.h as usize;
    let thumb_h = (visible * visible / total).max(1).min(visible);
    let max_start = total.saturating_sub(visible);
    let thumb_top = if max_start == 0 {
        0
    } else {
        start.min(max_start) * visible.saturating_sub(thumb_h) / max_start
    };

    for row in 0..visible {
        let (glyph, style) = if row >= thumb_top && row < thumb_top + thumb_h {
            ("█", thumb_style)
        } else {
            ("│", track_style)
        };
        canvas.print(area.x, area.y + row as u16, glyph, style);
    }
}

pub fn render_table(canvas: &mut Canvas, area: Rect, columns: &[TableColumn], rows: &[Vec<TableCell>]) {
    if area.w == 0 || area.h == 0 || columns.is_empty() {
        return;
    }

    let widths = resolve_column_widths(area.w, columns);
    let row_count = rows.len().min(area.h as usize);

    for (row_idx, row) in rows.iter().take(row_count).enumerate() {
        let y = area.y + row_idx as u16;
        let mut x = area.x;

        for (col_idx, column) in columns.iter().enumerate() {
            let width = widths.get(col_idx).copied().unwrap_or(0);
            if width == 0 || x >= area.right() {
                break;
            }

            if let Some(cell) = row.get(col_idx) {
                let shown = truncate_cells(&cell.text, width as usize);
                let offset = match column.align {
                    Align::Left => 0,
                    Align::Right => width.saturating_sub(text_width(&shown) as u16),
                };
                canvas.print(x + offset, y, &shown, cell.style);
            }

            x = x.saturating_add(width);
            if col_idx + 1 < columns.len() {
                x = x.saturating_add(1);
            }
        }
    }
}

pub fn agent_display_name(name: &str) -> String {
    match name {
        "bee" => "Bee".to_string(),
        "architecture" => "Architecture".to_string(),
        "backend" => "BackendEngineer".to_string(),
        "frontend" => "FrontendEngineer".to_string(),
        "security" => "SecurityAuditor".to_string(),
        "test" => "QAEngineer".to_string(),
        "devops" => "DevOpsEngineer".to_string(),
        "product_manager" => "ProductManager".to_string(),
        "mobile" => "MobileEngineer".to_string(),
        "data_scientist" => "DataScientist".to_string(),
        "dba" => "DBA".to_string(),
        "integration" => "IntegrationEngineer".to_string(),
        "reviewer" => "Reviewer".to_string(),
        _ => {
            let mut s = name.to_string();
            if let Some(first) = s.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            s
        }
    }
}

pub fn worker_color(name: &str) -> Color {
    const ROLES: &[(&str, Color)] = &[
        ("bee", AMBER_BRIGHT),
        ("arch", PURPLE),
        ("back", BLUE),
        ("front", CYAN),
        ("sec", PINK),
        ("test", YELLOW),
        ("devops", LAVENDER),
    ];
    ROLES
        .iter()
        .find(|(key, _)| name.contains(key))
        .map(|(_, color)| *color)
        .unwrap_or(SECONDARY)
}

fn resolve_column_widths(total_width: u16, columns: &[TableColumn]) -> Vec<u16> {
    let spacing = columns.len().saturating_sub(1) as u16;
    let available = total_width.saturating_sub(spacing);
    let fixed: u16 = columns.iter()
        .map(|c| match c.width {
            ColumnWidth::Fixed(width) => width,
            ColumnWidth::Fill => 0,
        })
        .sum();
    let fill_count = columns.iter().filter(|c| c.width == ColumnWidth::Fill).count() as u16;
    let fill_width = if fill_count > 0 {
        available.saturating_sub(fixed) / fill_count
    } else {
        0
    };

    columns.iter()
        .map(|c| match c.width {
            ColumnWidth::Fixed(width) => width.min(available),
            ColumnWidth::Fill => fill_width,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::term::{AMBER_DIM, DIM, GREEN};

    #[test]
    fn truncate_cells_never_splits_wide_glyphs() {
        assert_eq!(truncate_cells("abc🐝Z", 4), "abc");
        assert_eq!(truncate_cells("abc🐝Z", 5), "abc🐝");
    }

    #[test]
    fn wrapped_lines_respect_terminal_cell_width() {
        let mut lines = Vec::new();
        push_wrapped_lines(&mut lines, "abc🐝Z", 4, Style::new(), 0);

        assert!(lines.iter().all(|line| text_width(&line.text) <= 4));
        assert!(lines.iter().any(|line| line.text.contains('Z')));
    }

    #[test]
    fn scrollbar_renders_thumb_and_track() {
        let mut canvas = Canvas::new(3, 5);
        render_scrollbar(
            &mut canvas,
            Rect::new(1, 0, 1, 5),
            20,
            5,
            Style::new().fg(AMBER_DIM),
            Style::new().fg(DIM),
        );
        let rows = canvas.to_text_rows();

        assert!(rows.iter().any(|row| row.contains('█')));
        assert!(rows.iter().any(|row| row.contains('│')));
    }

    #[test]
    fn table_renders_fill_and_right_aligned_columns() {
        let mut canvas = Canvas::new(20, 2);
        let columns = [
            TableColumn::fixed(1, Align::Left),
            TableColumn::fill(Align::Left),
            TableColumn::fixed(5, Align::Right),
        ];
        let rows = vec![vec![
            TableCell::new("●", Style::new().fg(GREEN)),
            TableCell::new("src/main.rs", Style::new()),
            TableCell::new("HIGH", Style::new().fg(AMBER_DIM)),
        ]];

        render_table(&mut canvas, Rect::new(0, 0, 20, 1), &columns, &rows);
        let row = canvas.to_text_rows().remove(0);

        assert!(row.contains("● src/main"));
        assert!(row.contains(" HIGH"));
    }

    #[test]
    fn agent_identity_is_shared_across_layouts() {
        assert_eq!(agent_display_name("backend"), "BackendEngineer");
        assert_eq!(agent_display_name("custom_agent"), "Custom_agent");
        assert_eq!(worker_color("frontend"), CYAN);
    }
}
