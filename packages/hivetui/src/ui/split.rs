use crate::{
    term::{Canvas, Rect, Style, AMBER_DIM},
    ui::layout::{split_rects, Axis, Constraint},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SplitPane {
    pub axis: Axis,
    pub gap: u16,
    pub constraints: Vec<Constraint>,
    pub draggable: bool,
}

impl SplitPane {
    pub fn new(axis: Axis, constraints: impl Into<Vec<Constraint>>) -> Self {
        Self {
            axis,
            gap: 1,
            constraints: constraints.into(),
            draggable: true,
        }
    }

    pub fn with_gap(mut self, gap: u16) -> Self {
        self.gap = gap;
        self
    }
}

pub fn split_panes(area: Rect, split: &SplitPane) -> (Vec<Rect>, Vec<Rect>) {
    let panes = split_rects(area, split.axis, split.gap, &split.constraints);
    let handles = panes
        .windows(2)
        .map(|pair| match split.axis {
            Axis::Horizontal => Rect::new(pair[0].right(), area.y, split.gap, area.h),
            Axis::Vertical => Rect::new(area.x, pair[0].bottom(), area.w, split.gap),
        })
        .filter(|rect| rect.w > 0 && rect.h > 0)
        .collect();
    (panes, handles)
}

pub fn render_split_handles(canvas: &mut Canvas, handles: &[Rect], axis: Axis) {
    for handle in handles {
        match axis {
            Axis::Horizontal => {
                for y in handle.y..handle.bottom() {
                    canvas.print(handle.x, y, "│", Style::new().fg(AMBER_DIM));
                }
            }
            Axis::Vertical => {
                let line = "─".repeat(handle.w as usize);
                canvas.print(handle.x, handle.y, &line, Style::new().fg(AMBER_DIM));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_panes_and_handle_rects() {
        let split = SplitPane::new(
            Axis::Horizontal,
            vec![Constraint::Percent(40), Constraint::Fill(1)],
        );
        let (panes, handles) = split_panes(Rect::new(0, 0, 100, 20), &split);

        assert_eq!(panes.len(), 2);
        assert_eq!(handles.len(), 1);
        assert_eq!(handles[0].h, 20);
    }
}
