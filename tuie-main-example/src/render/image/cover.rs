//! Aspect-cropping RGBA resampler.

use image::imageops::FilterType;
use image::{ImageBuffer, Rgba};

use super::source::{PixelFormat, SourceData};

const FILTER: FilterType = FilterType::CatmullRom;

fn premultiply(rgba: &mut [u8]) {
    for p in rgba.chunks_exact_mut(4) {
        let a = p[3] as u32;
        p[0] = ((p[0] as u32 * a + 127) / 255) as u8;
        p[1] = ((p[1] as u32 * a + 127) / 255) as u8;
        p[2] = ((p[2] as u32 * a + 127) / 255) as u8;
    }
}

fn unpremultiply(rgba: &mut [u8]) {
    for p in rgba.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a == 0 {
            continue;
        }
        p[0] = ((p[0] as u32 * 255 + a / 2) / a).min(255) as u8;
        p[1] = ((p[1] as u32 * 255 + a / 2) / a).min(255) as u8;
        p[2] = ((p[2] as u32 * 255 + a / 2) / a).min(255) as u8;
    }
}

fn inscribe_aspect(src_w: u32, src_h: u32, aspect_w: u32, aspect_h: u32) -> (u32, u32) {
    let by_w = src_w as u64 * aspect_h as u64;
    let by_h = src_h as u64 * aspect_w as u64;
    if by_w <= by_h {
        (src_w, (by_w / aspect_w as u64) as u32)
    } else {
        ((by_h / aspect_h as u64) as u32, src_h)
    }
}

fn crop_and_resize(
    mut rgba: Vec<u8>,
    src_w: u32,
    src_h: u32,
    aspect_w: u32,
    aspect_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Option<Vec<u8>> {
    if src_w == 0 || src_h == 0 || aspect_w == 0 || aspect_h == 0 || dst_w == 0 || dst_h == 0 {
        return None;
    }
    premultiply(&mut rgba);
    let img = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_vec(src_w, src_h, rgba)?;
    let (crop_w, crop_h) = inscribe_aspect(src_w, src_h, aspect_w, aspect_h);
    let crop_x = (src_w - crop_w) / 2;
    let crop_y = (src_h - crop_h) / 2;
    let cropped = image::imageops::crop_imm(&img, crop_x, crop_y, crop_w, crop_h).to_image();
    let mut final_pixels = if crop_w == dst_w && crop_h == dst_h {
        cropped.into_raw()
    } else {
        image::imageops::resize(&cropped, dst_w, dst_h, FILTER).into_raw()
    };
    unpremultiply(&mut final_pixels);
    Some(final_pixels)
}

pub(super) fn decode_rgba(
    data: &SourceData,
    aspect_w: u32,
    aspect_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Option<Vec<u8>> {
    match data {
        SourceData::Raw { width, height, pixels, format } => {
            let rgba: Vec<u8> = match format {
                PixelFormat::Rgba => pixels.clone(),
                PixelFormat::Rgb => {
                    pixels.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect()
                }
            };
            crop_and_resize(rgba, *width, *height, aspect_w, aspect_h, dst_w, dst_h)
        }
        SourceData::Encoded { bytes, .. } => {
            let rgba_img = image::load_from_memory(bytes).ok()?.to_rgba8();
            let (src_w, src_h) = (rgba_img.width(), rgba_img.height());
            crop_and_resize(rgba_img.into_raw(), src_w, src_h, aspect_w, aspect_h, dst_w, dst_h)
        }
    }
}
