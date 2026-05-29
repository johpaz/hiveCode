use crate::term::{Canvas, Rect, Style, DIM};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScrollbarState {
    pub offset: usize,
    pub total: usize,
    pub viewport: usize,
}

impl ScrollbarState {
    pub fn new(total: usize, viewport: usize, offset: usize) -> Self {
        let mut state = Self { offset, total, viewport };
        state.clamp();
        state
    }

    pub fn max_offset(self) -> usize {
        self.total.saturating_sub(self.viewport)
    }

    pub fn can_scroll(self) -> bool {
        self.total > self.viewport && self.viewport > 0
    }

    pub fn scroll_by(&mut self, delta: isize) {
        if delta < 0 {
            self.offset = self.offset.saturating_sub(delta.unsigned_abs());
        } else {
            self.offset = self.offset.saturating_add(delta as usize);
        }
        self.clamp();
    }

    pub fn set_progress(&mut self, progress: f32) {
        let progress = progress.clamp(0.0, 1.0);
        self.offset = (self.max_offset() as f32 * progress).round() as usize;
        self.clamp();
    }

    pub fn thumb_rect(self, track: Rect) -> Rect {
        if track.h == 0 || !self.can_scroll() {
            return Rect::new(track.x, track.y, track.w, 0);
        }

        let visible = track.h as usize;
        let thumb_h = ((visible * visible) / self.total).max(1).min(visible);
        let max_offset = self.max_offset();
        let top = if max_offset == 0 {
            0
        } else {
            self.offset.min(max_offset) * visible.saturating_sub(thumb_h) / max_offset
        };
        Rect::new(track.x, track.y + top as u16, track.w, thumb_h as u16)
    }

    fn clamp(&mut self) {
        self.offset = self.offset.min(self.max_offset());
    }
}

pub fn render_vertical_scrollbar(
    canvas: &mut Canvas,
    area: Rect,
    state: ScrollbarState,
    thumb_style: Style,
    track_style: Style,
) {
    if area.h == 0 || !state.can_scroll() {
        return;
    }

    let thumb = state.thumb_rect(area);
    for row in area.y..area.bottom() {
        let in_thumb = row >= thumb.y && row < thumb.bottom();
        let (glyph, style) = if in_thumb {
            ("█", thumb_style)
        } else {
            ("│", track_style)
        };
        canvas.print(area.x, row, glyph, style);
    }
}

pub fn render_subtle_scrollbar(canvas: &mut Canvas, area: Rect, total: usize, viewport: usize, offset: usize) {
    render_vertical_scrollbar(
        canvas,
        area,
        ScrollbarState::new(total, viewport, offset),
        Style::new().fg(DIM),
        Style::new().fg(DIM),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_offset_to_scrollable_range() {
        let state = ScrollbarState::new(100, 20, 500);
        assert_eq!(state.offset, 80);
    }

    #[test]
    fn computes_thumb_inside_track() {
        let state = ScrollbarState::new(100, 20, 40);
        let thumb = state.thumb_rect(Rect::new(9, 2, 1, 10));

        assert_eq!(thumb.x, 9);
        assert!(thumb.y >= 2);
        assert!(thumb.bottom() <= 12);
        assert!(thumb.h > 0);
    }
}
