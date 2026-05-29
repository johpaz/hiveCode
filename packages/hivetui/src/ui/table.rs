use crate::{
    term::{Canvas, Rect, Style, AMBER_DIM, BG_ELEVATED, DIM, SECONDARY, WHITE},
    ui::text::{cell_width, ellipsize_cells},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableAlign {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableWidth {
    Fixed(u16),
    Fill(u16),
    Percent(u16),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableColumn {
    pub header: String,
    pub width: TableWidth,
    pub align: TableAlign,
}

impl TableColumn {
    pub fn fixed(header: impl Into<String>, width: u16, align: TableAlign) -> Self {
        Self { header: header.into(), width: TableWidth::Fixed(width), align }
    }

    pub fn fill(header: impl Into<String>, weight: u16, align: TableAlign) -> Self {
        Self { header: header.into(), width: TableWidth::Fill(weight.max(1)), align }
    }

    pub fn percent(header: impl Into<String>, percent: u16, align: TableAlign) -> Self {
        Self { header: header.into(), width: TableWidth::Percent(percent.min(100)), align }
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TableState {
    pub selected: Option<usize>,
    pub scroll: usize,
    pub hscroll: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DataTable {
    pub show_header: bool,
    pub zebra: bool,
    pub selected_style: Style,
    pub header_style: Style,
}

impl Default for DataTable {
    fn default() -> Self {
        Self {
            show_header: true,
            zebra: true,
            selected_style: Style::new().fg(WHITE).bg(BG_ELEVATED).bold(),
            header_style: Style::new().fg(AMBER_DIM).bold(),
        }
    }
}

pub fn render_data_table(
    canvas: &mut Canvas,
    area: Rect,
    columns: &[TableColumn],
    rows: &[Vec<TableCell>],
    state: TableState,
    options: &DataTable,
) {
    if area.w == 0 || area.h == 0 || columns.is_empty() {
        return;
    }

    let widths = resolve_widths(area.w, columns);
    let mut body = area;
    if options.show_header && area.h > 0 {
        render_row(
            canvas,
            area.x,
            area.y,
            area.w,
            columns,
            &widths,
            &columns
                .iter()
                .map(|column| TableCell::new(column.header.clone(), options.header_style))
                .collect::<Vec<_>>(),
            None,
        );
        body.y = body.y.saturating_add(1);
        body.h = body.h.saturating_sub(1);
    }

    let visible = body.h as usize;
    let range = crate::ui::virtual_list::visible_range(rows.len(), visible, state.scroll);
    for (screen_row, row_idx) in range.enumerate() {
        let y = body.y + screen_row as u16;
        let row_style = if options.zebra && row_idx % 2 == 1 {
            Some(Style::new().bg(crate::term::BG_PANEL))
        } else {
            None
        };
        if state.selected == Some(row_idx) {
            canvas.fill_rect(Rect::new(body.x, y, body.w, 1), ' ', options.selected_style);
        } else if let Some(style) = row_style {
            canvas.fill_rect(Rect::new(body.x, y, body.w, 1), ' ', style);
        }
        if let Some(row) = rows.get(row_idx) {
            render_row(canvas, body.x, y, body.w, columns, &widths, row, state.selected.filter(|idx| *idx == row_idx));
        }
    }
}

fn render_row(
    canvas: &mut Canvas,
    x: u16,
    y: u16,
    total_w: u16,
    columns: &[TableColumn],
    widths: &[u16],
    row: &[TableCell],
    selected: Option<usize>,
) {
    let mut cx = x;
    for (idx, column) in columns.iter().enumerate() {
        let width = widths.get(idx).copied().unwrap_or(0);
        if width == 0 || cx >= x.saturating_add(total_w) {
            break;
        }
        let cell = row.get(idx).cloned().unwrap_or_else(|| TableCell::new("", Style::new().fg(SECONDARY)));
        let text = ellipsize_cells(&cell.text, width as usize);
        let text_w = cell_width(&text) as u16;
        let offset = match column.align {
            TableAlign::Left => 0,
            TableAlign::Center => width.saturating_sub(text_w) / 2,
            TableAlign::Right => width.saturating_sub(text_w),
        };
        let style = if selected.is_some() {
            Style { bg: BG_ELEVATED, ..cell.style }
        } else {
            cell.style
        };
        canvas.print(cx + offset, y, &text, style);
        cx = cx.saturating_add(width).saturating_add(1);
    }
}

fn resolve_widths(total_w: u16, columns: &[TableColumn]) -> Vec<u16> {
    let spacing = columns.len().saturating_sub(1) as u16;
    let available = total_w.saturating_sub(spacing);
    let mut widths = vec![0u16; columns.len()];
    let mut used = 0u32;
    let mut fill_weight = 0u32;

    for (idx, column) in columns.iter().enumerate() {
        match column.width {
            TableWidth::Fixed(width) => {
                widths[idx] = width;
                used += width as u32;
            }
            TableWidth::Percent(percent) => {
                let width = ((available as u32 * percent as u32) / 100).min(u16::MAX as u32) as u16;
                widths[idx] = width;
                used += width as u32;
            }
            TableWidth::Fill(weight) => {
                fill_weight += weight as u32;
            }
        }
    }

    let remaining = available.saturating_sub(used.min(available as u32) as u16) as u32;
    for (idx, column) in columns.iter().enumerate() {
        if let TableWidth::Fill(weight) = column.width {
            widths[idx] = if fill_weight == 0 {
                0
            } else {
                ((remaining * weight as u32) / fill_weight).min(u16::MAX as u32) as u16
            };
        }
    }

    let used_after: u32 = widths.iter().map(|v| *v as u32).sum();
    if used_after < available as u32 {
        if let Some(last) = widths.iter_mut().rev().find(|w| **w > 0) {
            *last = last.saturating_add((available as u32 - used_after).min(u16::MAX as u32) as u16);
        }
    }

    widths
}

pub fn empty_row(message: impl Into<String>) -> Vec<TableCell> {
    vec![TableCell::new(message, Style::new().fg(DIM))]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_header_selection_and_fill_columns() {
        let mut canvas = Canvas::new(40, 5);
        let columns = [
            TableColumn::fixed("S", 3, TableAlign::Left),
            TableColumn::fill("Name", 1, TableAlign::Left),
            TableColumn::fixed("N", 4, TableAlign::Right),
        ];
        let rows = vec![
            vec![
                TableCell::new("ok", Style::new().fg(WHITE)),
                TableCell::new("backend worker", Style::new().fg(SECONDARY)),
                TableCell::new("10", Style::new().fg(SECONDARY)),
            ],
        ];

        render_data_table(
            &mut canvas,
            Rect::new(0, 0, 40, 5),
            &columns,
            &rows,
            TableState { selected: Some(0), scroll: 0, hscroll: 0 },
            &DataTable::default(),
        );

        let rows = canvas.to_text_rows();
        assert!(rows[0].contains("Name"));
        assert!(rows[1].contains("backend worker"));
    }
}
