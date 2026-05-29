use crate::term::{Canvas, Color, Rect, Style, AMBER_DIM, BG_PANEL, SECONDARY};

#[derive(Clone, Debug, PartialEq)]
pub struct PaneStyle {
    pub title: Option<String>,
    pub border: bool,
    pub border_color: Color,
    pub background: Color,
    pub title_color: Color,
}

impl PaneStyle {
    pub fn titled(title: impl Into<String>) -> Self {
        Self { title: Some(title.into()), ..Self::default() }
    }
}

impl Default for PaneStyle {
    fn default() -> Self {
        Self {
            title: None,
            border: true,
            border_color: AMBER_DIM,
            background: BG_PANEL,
            title_color: SECONDARY,
        }
    }
}

pub fn render_pane(canvas: &mut Canvas, area: Rect, style: &PaneStyle) -> Rect {
    if area.w == 0 || area.h == 0 {
        return area;
    }

    canvas.fill_rect(area, ' ', Style::new().bg(style.background));

    if style.border && area.w >= 2 && area.h >= 2 {
        canvas.draw_border(area, Style::new().fg(style.border_color).bg(style.background));
        if let Some(title) = &style.title {
            let max = area.w.saturating_sub(4) as usize;
            let shown = crate::ui::text::truncate_cells(title, max);
            canvas.print(area.x + 2, area.y, &shown, Style::new().fg(style.title_color).bold().bg(style.background));
        }
        Rect::new(area.x + 1, area.y + 1, area.w.saturating_sub(2), area.h.saturating_sub(2))
    } else {
        area
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_inner_rect_for_bordered_pane() {
        let mut canvas = Canvas::new(20, 5);
        let inner = render_pane(&mut canvas, Rect::new(0, 0, 20, 5), &PaneStyle::titled("TITLE"));

        assert_eq!(inner, Rect::new(1, 1, 18, 3));
        assert!(canvas.to_text_rows()[0].contains("TITLE"));
    }
}
