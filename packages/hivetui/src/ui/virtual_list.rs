use std::ops::Range;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VirtualListState {
    pub scroll: usize,
    pub selected: Option<usize>,
    pub total: usize,
}

impl VirtualListState {
    pub fn new(total: usize) -> Self {
        Self { scroll: 0, selected: None, total }
    }

    pub fn clamp(&mut self, viewport: usize) {
        self.scroll = self.scroll.min(self.total.saturating_sub(viewport));
        if let Some(selected) = self.selected {
            self.selected = Some(selected.min(self.total.saturating_sub(1)));
        }
    }

    pub fn ensure_visible(&mut self, index: usize, viewport: usize) {
        if viewport == 0 || self.total == 0 {
            return;
        }
        let index = index.min(self.total - 1);
        if index < self.scroll {
            self.scroll = index;
        } else if index >= self.scroll + viewport {
            self.scroll = index + 1 - viewport;
        }
        self.selected = Some(index);
        self.clamp(viewport);
    }

    pub fn range(self, viewport: usize) -> Range<usize> {
        visible_range(self.total, viewport, self.scroll)
    }
}

pub fn visible_range(total: usize, viewport: usize, scroll: usize) -> Range<usize> {
    if total == 0 || viewport == 0 {
        return 0..0;
    }
    let start = scroll.min(total.saturating_sub(viewport));
    let end = start.saturating_add(viewport).min(total);
    start..end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_range_clamps_to_end() {
        assert_eq!(visible_range(10, 4, 99), 6..10);
    }

    #[test]
    fn ensure_visible_moves_scroll_window() {
        let mut state = VirtualListState::new(100);
        state.ensure_visible(40, 10);

        assert_eq!(state.selected, Some(40));
        assert_eq!(state.scroll, 31);
    }
}
