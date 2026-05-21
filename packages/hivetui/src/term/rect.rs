#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

impl Rect {
    pub fn new(x: u16, y: u16, w: u16, h: u16) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> u16 {
        self.x + self.w
    }

    pub fn bottom(&self) -> u16 {
        self.y + self.h
    }

    pub fn vsplit(self, heights: &[u16]) -> Vec<Rect> {
        split(self, heights, true)
    }

    pub fn hsplit(self, widths: &[u16]) -> Vec<Rect> {
        split(self, widths, false)
    }
}

fn split(r: Rect, sizes: &[u16], vertical: bool) -> Vec<Rect> {
    let total = if vertical { r.h } else { r.w };
    let fixed: u16 = sizes.iter().sum();
    let fills = sizes.iter().filter(|&&s| s == 0).count() as u16;
    let fill_size = if fills > 0 {
        total.saturating_sub(fixed) / fills
    } else {
        0
    };

    let mut rects = Vec::with_capacity(sizes.len());
    let mut offset = 0u16;

    for &size in sizes {
        let actual = if size == 0 { fill_size } else { size };
        let rect = if vertical {
            Rect::new(r.x, r.y + offset, r.w, actual.min(total.saturating_sub(offset)))
        } else {
            Rect::new(r.x + offset, r.y, actual.min(total.saturating_sub(offset)), r.h)
        };
        rects.push(rect);
        offset += actual;
        if offset >= total {
            break;
        }
    }

    rects
}
