//! Rasterizes decoration sprites into u8 alpha masks.

use crate::prelude::UnderlineType;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum DecoStyle {
    Underline(UnderlineType),
    Strikethrough,
    CursorBeam,
    CursorUnderline,
    CursorBlockOutline,
}

pub(super) fn rasterize(
    style: DecoStyle,
    cell_w: u32,
    cell_h: u32,
    underline_pos: u32,
    underline_thickness: u32,
    strike_pos: u32,
    strike_thickness: u32,
) -> Vec<u8> {
    let mut buf = vec![0u8; (cell_w * cell_h) as usize];
    if cell_w == 0 || cell_h == 0 {
        return buf;
    }
    type Draw = fn(&mut [u8], u32, u32, u32, u32);
    let (draw, pos, thick): (Draw, u32, u32) = match style {
        DecoStyle::Strikethrough => (straight, strike_pos, strike_thickness),
        DecoStyle::Underline(UnderlineType::None) => return buf,
        DecoStyle::Underline(UnderlineType::Single) => (straight, underline_pos, underline_thickness),
        DecoStyle::Underline(UnderlineType::Double) => (double, underline_pos, underline_thickness),
        DecoStyle::Underline(UnderlineType::Dotted) => (dotted, underline_pos, underline_thickness),
        DecoStyle::Underline(UnderlineType::Dashed) => (dashed, underline_pos, underline_thickness),
        DecoStyle::Underline(UnderlineType::Curly) => (curly, underline_pos, underline_thickness),
        DecoStyle::CursorBeam => {
            cursor_beam(&mut buf, cell_w, cell_h, underline_thickness);
            return buf;
        }
        DecoStyle::CursorUnderline => {
            cursor_underline(&mut buf, cell_w, cell_h, underline_thickness);
            return buf;
        }
        DecoStyle::CursorBlockOutline => {
            cursor_block_outline(&mut buf, cell_w, cell_h, underline_thickness);
            return buf;
        }
    };
    draw(&mut buf, cell_w, cell_h, pos, thick);
    buf
}

fn fill_rect(buf: &mut [u8], cell_w: u32, x: u32, y: u32, w: u32, h: u32) {
    for row in y..y + h {
        let start = (row * cell_w + x) as usize;
        buf[start..start + w as usize].fill(0xff);
    }
}

fn cursor_beam(buf: &mut [u8], cell_w: u32, cell_h: u32, thickness: u32) {
    let w = thickness.clamp(1, cell_w);
    fill_rect(buf, cell_w, 0, 0, w, cell_h);
}

fn cursor_underline(buf: &mut [u8], cell_w: u32, cell_h: u32, thickness: u32) {
    let h = thickness.clamp(1, cell_h);
    fill_rect(buf, cell_w, 0, cell_h - h, cell_w, h);
}

fn cursor_block_outline(buf: &mut [u8], cell_w: u32, cell_h: u32, thickness: u32) {
    let tx = thickness.clamp(1, cell_w);
    let ty = thickness.clamp(1, cell_h);
    fill_rect(buf, cell_w, 0, 0, cell_w, ty);
    fill_rect(buf, cell_w, 0, cell_h - ty, cell_w, ty);
    fill_rect(buf, cell_w, 0, 0, tx, cell_h);
    fill_rect(buf, cell_w, cell_w - tx, 0, tx, cell_h);
}

fn band_slice(buf: &mut [u8], cell_w: u32, cell_h: u32, center: u32, thickness: u32) -> &mut [u8] {
    let top = center.saturating_sub(thickness / 2).min(cell_h);
    let end = (top + thickness).min(cell_h);
    let s = (top * cell_w) as usize;
    let e = (end * cell_w) as usize;
    &mut buf[s..e]
}

fn straight(buf: &mut [u8], cell_w: u32, cell_h: u32, center: u32, thickness: u32) {
    band_slice(buf, cell_w, cell_h, center, thickness).fill(0xff);
}

fn double(buf: &mut [u8], cell_w: u32, cell_h: u32, center: u32, thickness: u32) {
    let t = thickness.max(1);
    let total_span = 3 * t;
    let upper_top = center.saturating_sub(total_span / 2);
    let lower_top = upper_top + 2 * t;
    if lower_top + t > cell_h {
        straight(buf, cell_w, cell_h, center, t);
        return;
    }
    let cw = cell_w as usize;
    for top in [upper_top, lower_top] {
        for y in top..(top + t) {
            let row = (y * cell_w) as usize;
            buf[row..row + cw].fill(0xff);
        }
    }
}

fn dotted(buf: &mut [u8], cell_w: u32, cell_h: u32, center: u32, thickness: u32) {
    let t = thickness.max(1);
    let target_stride = 3 * t;
    let k = ((cell_w + target_stride / 2) / target_stride).max(1);
    let cw = cell_w as usize;
    for row in band_slice(buf, cell_w, cell_h, center, thickness).chunks_exact_mut(cw) {
        for i in 0..k {
            let start = (i * cell_w + k / 2) / k;
            let end = (start + t).min(cell_w);
            row[start as usize..end as usize].fill(0xff);
        }
    }
}

fn dashed(buf: &mut [u8], cell_w: u32, cell_h: u32, center: u32, thickness: u32) {
    let t = thickness.max(1);
    let target_stride = 6 * t;
    let n = ((cell_w + target_stride / 2) / target_stride).max(1);
    let dash_w = ((cell_w * 2) / (3 * n)).max(1);
    let cw = cell_w as usize;
    for row in band_slice(buf, cell_w, cell_h, center, thickness).chunks_exact_mut(cw) {
        for i in 0..n {
            let start = (i * cell_w + n / 2) / n;
            let end = (start + dash_w).min(cell_w);
            row[start as usize..end as usize].fill(0xff);
        }
    }
}

fn curly(buf: &mut [u8], cell_w: u32, cell_h: u32, center: u32, thickness: u32) {
    let thick = thickness.max(1) as f32;
    let half_t = thick * 0.5;
    let amp_room = ((cell_h as f32 - thick) * 0.5).max(0.5);
    let amp = amp_room.min(thick.max(1.5));
    let cy_min = amp + half_t;
    let cy_max = (cell_h as f32 - amp - half_t).max(cy_min);
    let cy = (center as f32 + 0.5).clamp(cy_min, cy_max);
    let omega = std::f32::consts::TAU / (cell_w as f32);
    let y_max_f = (cell_h - 1) as f32;

    for x in 0..cell_w {
        let phase = ((x as f32) + 0.5) * omega;
        let wave_y = cy + amp * phase.cos();
        let y_lo = (wave_y - half_t - 1.0).floor().max(0.0) as i32;
        let y_hi = (wave_y + half_t + 1.0).ceil().min(y_max_f) as i32;
        for y in y_lo..=y_hi {
            let d = ((y as f32) + 0.5 - wave_y).abs();
            let cov = (half_t + 0.5 - d).clamp(0.0, 1.0);
            if cov > 0.0 {
                let idx = (y as u32 * cell_w + x) as usize;
                let v = (cov * 255.0).round() as u8;
                buf[idx] = buf[idx].saturating_add(v);
            }
        }
    }
}
