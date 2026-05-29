use crate::term::Rect;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HitAction {
    ActivateTab(String),
    SelectRow(usize),
    Scroll { target: String },
    ResizeSplit { id: String },
    Command(String),
    Custom(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct MouseRegion {
    pub id: String,
    pub rect: Rect,
    pub z: i16,
    pub action: HitAction,
}

impl MouseRegion {
    pub fn new(id: impl Into<String>, rect: Rect, z: i16, action: HitAction) -> Self {
        Self { id: id.into(), rect, z, action }
    }
}

#[derive(Default, Debug)]
pub struct HitMap {
    regions: Vec<MouseRegion>,
}

impl HitMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.regions.clear();
    }

    pub fn push(&mut self, region: MouseRegion) {
        if region.rect.w > 0 && region.rect.h > 0 {
            self.regions.push(region);
        }
    }

    pub fn hit(&self, x: u16, y: u16) -> Option<&MouseRegion> {
        self.regions
            .iter()
            .rev()
            .filter(|region| region.rect.contains(x, y))
            .max_by_key(|region| region.z)
    }

    pub fn regions(&self) -> &[MouseRegion] {
        &self.regions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_topmost_region() {
        let mut map = HitMap::new();
        map.push(MouseRegion::new(
            "base",
            Rect::new(0, 0, 10, 10),
            0,
            HitAction::Custom("base".into()),
        ));
        map.push(MouseRegion::new(
            "modal",
            Rect::new(2, 2, 4, 4),
            10,
            HitAction::Custom("modal".into()),
        ));

        assert_eq!(map.hit(3, 3).unwrap().id, "modal");
        assert_eq!(map.hit(1, 1).unwrap().id, "base");
        assert!(map.hit(20, 20).is_none());
    }

    #[test]
    fn ignores_empty_regions() {
        let mut map = HitMap::new();
        map.push(MouseRegion::new(
            "empty",
            Rect::new(0, 0, 0, 2),
            0,
            HitAction::Custom("empty".into()),
        ));
        assert!(map.regions().is_empty());
    }
}
