use crate::term::Rect;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    Horizontal,
    Vertical,
}

impl Axis {
    fn main(self, rect: Rect) -> u16 {
        match self {
            Axis::Horizontal => rect.w,
            Axis::Vertical => rect.h,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlexSpec {
    pub basis: u16,
    pub min: u16,
    pub max: u16,
    pub grow: u16,
}

impl FlexSpec {
    pub const fn new(basis: u16, min: u16, max: u16, grow: u16) -> Self {
        Self { basis, min, max, grow }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Constraint {
    Fixed(u16),
    Percent(u16),
    Fill(u16),
    Preferred(FlexSpec),
}

pub fn resolve_constraints(total: u16, gap: u16, constraints: &[Constraint]) -> Vec<u16> {
    if constraints.is_empty() {
        return Vec::new();
    }

    let gap_total = gap as u32 * constraints.len().saturating_sub(1) as u32;
    let available = (total as u32).saturating_sub(gap_total).min(u16::MAX as u32) as u16;
    let mut sizes = vec![0u16; constraints.len()];
    let mut flex_items: Vec<(usize, FlexSpec)> = Vec::new();
    let mut used = 0u32;

    for (idx, constraint) in constraints.iter().copied().enumerate() {
        match constraint {
            Constraint::Fixed(width) => {
                sizes[idx] = width;
                used = used.saturating_add(width as u32);
            }
            Constraint::Percent(percent) => {
                let size = ((available as u32 * percent.min(100) as u32) / 100).min(u16::MAX as u32) as u16;
                sizes[idx] = size;
                used = used.saturating_add(size as u32);
            }
            Constraint::Fill(weight) => {
                flex_items.push((idx, FlexSpec::new(0, 0, u16::MAX, weight.max(1))));
            }
            Constraint::Preferred(spec) => {
                flex_items.push((idx, spec));
            }
        }
    }

    if flex_items.is_empty() {
        return clamp_to_available(sizes, available);
    }

    let remaining = available.saturating_sub(used.min(available as u32) as u16);
    let mut specs: Vec<FlexSpec> = flex_items.iter().map(|(_, spec)| *spec).collect();
    let resolved = resolve_flex(&mut specs, remaining);
    for ((idx, _), size) in flex_items.into_iter().zip(resolved) {
        sizes[idx] = size;
    }

    clamp_to_available(sizes, available)
}

pub fn split_rects(area: Rect, axis: Axis, gap: u16, constraints: &[Constraint]) -> Vec<Rect> {
    let sizes = resolve_constraints(axis.main(area), gap, constraints);
    let mut offset = 0u16;
    let mut rects = Vec::with_capacity(sizes.len());

    for size in sizes {
        let rect = match axis {
            Axis::Horizontal => Rect::new(area.x + offset, area.y, size, area.h),
            Axis::Vertical => Rect::new(area.x, area.y + offset, area.w, size),
        };
        rects.push(rect);
        offset = offset.saturating_add(size).saturating_add(gap);
    }

    rects
}

fn resolve_flex(items: &mut [FlexSpec], total: u16) -> Vec<u16> {
    if items.is_empty() {
        return Vec::new();
    }

    let min_total: u32 = items.iter().map(|it| it.min as u32).sum();
    if min_total >= total as u32 {
        return proportional_floor(items.iter().map(|it| it.min), total);
    }

    let basis_total: u32 = items.iter().map(|it| it.basis.clamp(it.min, it.max) as u32).sum();
    let grow = basis_total < total as u32;

    if grow {
        grow_flex(items, total)
    } else {
        shrink_flex(items, total)
    }
}

fn grow_flex(items: &[FlexSpec], total: u16) -> Vec<u16> {
    let mut out: Vec<u16> = items.iter().map(|it| it.basis.clamp(it.min, it.max)).collect();
    let mut used: u32 = out.iter().map(|v| *v as u32).sum();
    let mut open: Vec<usize> = (0..items.len()).collect();

    while used < total as u32 && !open.is_empty() {
        let remaining = total as u32 - used;
        let weight: u32 = open.iter().map(|idx| items[*idx].grow.max(1) as u32).sum();
        let mut consumed = 0u32;
        let mut next_open = Vec::new();

        for idx in open {
            let share = ((remaining * items[idx].grow.max(1) as u32) / weight).max(1);
            let room = items[idx].max.saturating_sub(out[idx]) as u32;
            let add = share.min(room);
            out[idx] = out[idx].saturating_add(add as u16);
            consumed += add;
            if out[idx] < items[idx].max {
                next_open.push(idx);
            }
        }

        if consumed == 0 {
            break;
        }
        used += consumed;
        open = next_open;
    }

    clamp_to_available(out, total)
}

fn shrink_flex(items: &[FlexSpec], total: u16) -> Vec<u16> {
    let mut out: Vec<u16> = items.iter().map(|it| it.basis.clamp(it.min, it.max)).collect();
    let mut used: u32 = out.iter().map(|v| *v as u32).sum();
    let mut open: Vec<usize> = (0..items.len()).collect();

    while used > total as u32 && !open.is_empty() {
        let excess = used - total as u32;
        let weight: u32 = open.iter().map(|idx| out[*idx].max(1) as u32).sum();
        let mut removed = 0u32;
        let mut next_open = Vec::new();

        for idx in open {
            let share = ((excess * out[idx].max(1) as u32) / weight).max(1);
            let room = out[idx].saturating_sub(items[idx].min) as u32;
            let sub = share.min(room);
            out[idx] = out[idx].saturating_sub(sub as u16);
            removed += sub;
            if out[idx] > items[idx].min {
                next_open.push(idx);
            }
        }

        if removed == 0 {
            break;
        }
        used -= removed;
        open = next_open;
    }

    clamp_to_available(out, total)
}

fn clamp_to_available(mut sizes: Vec<u16>, available: u16) -> Vec<u16> {
    let mut used: u32 = sizes.iter().map(|v| *v as u32).sum();
    while used > available as u32 {
        let Some((idx, _)) = sizes.iter().enumerate().filter(|(_, v)| **v > 0).max_by_key(|(_, v)| **v) else {
            break;
        };
        sizes[idx] -= 1;
        used -= 1;
    }
    sizes
}

fn proportional_floor(values: impl Iterator<Item = u16>, total: u16) -> Vec<u16> {
    let raw: Vec<u16> = values.collect();
    let sum: u32 = raw.iter().map(|v| *v as u32).sum();
    if sum == 0 {
        return vec![0; raw.len()];
    }
    raw.into_iter()
        .map(|v| ((v as u32 * total as u32) / sum).min(u16::MAX as u32) as u16)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_fixed_percent_and_fill() {
        let sizes = resolve_constraints(
            100,
            1,
            &[
                Constraint::Fixed(20),
                Constraint::Percent(25),
                Constraint::Fill(1),
                Constraint::Fill(2),
            ],
        );

        assert_eq!(sizes.iter().sum::<u16>(), 97);
        assert_eq!(sizes[0], 20);
        assert_eq!(sizes[1], 24);
        assert!(sizes[3] >= sizes[2]);
    }

    #[test]
    fn preferred_items_respect_min_and_max() {
        let sizes = resolve_constraints(
            24,
            0,
            &[
                Constraint::Preferred(FlexSpec::new(20, 8, 12, 1)),
                Constraint::Preferred(FlexSpec::new(20, 8, 20, 1)),
            ],
        );

        assert_eq!(sizes.iter().sum::<u16>(), 24);
        assert!(sizes[0] <= 12);
        assert!(sizes[0] >= 8);
        assert!(sizes[1] <= 20);
        assert!(sizes[1] >= 8);
    }

    #[test]
    fn splits_rects_along_axis() {
        let rects = split_rects(
            Rect::new(2, 3, 20, 5),
            Axis::Horizontal,
            1,
            &[Constraint::Fixed(5), Constraint::Fill(1)],
        );

        assert_eq!(rects[0], Rect::new(2, 3, 5, 5));
        assert_eq!(rects[1], Rect::new(8, 3, 14, 5));
    }
}
