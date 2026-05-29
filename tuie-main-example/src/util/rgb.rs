//! sRGB color types and pixel utilities.

/// sRGB color as three 8-bit channels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgb {
    /// Red channel.
    pub r: u8,
    /// Green channel.
    pub g: u8,
    /// Blue channel.
    pub b: u8,
}

impl Rgb {
    /// Creates an RGB triplet from three 8-bit channels.
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    /// Creates an [`Rgb`] from a packed `0xRRGGBB` value.
    pub const fn from_hex(hex: u32) -> Self {
        Self {
            r: (hex >> 16) as u8,
            g: (hex >> 8) as u8,
            b: hex as u8,
        }
    }
}

/// Alpha-blends an RGBA pixel (4-byte slice) over an opaque `bg`.
#[cfg(feature = "images")]
#[inline(always)]
pub fn blend_over(px: &[u8], bg: Rgb) -> Rgb {
    let alpha = px[3] as u32;
    let inv_alpha = 255 - alpha;
    let r = ((px[0] as u32 * alpha + bg.r as u32 * inv_alpha + 127) / 255) as u8;
    let g = ((px[1] as u32 * alpha + bg.g as u32 * inv_alpha + 127) / 255) as u8;
    let b = ((px[2] as u32 * alpha + bg.b as u32 * inv_alpha + 127) / 255) as u8;
    Rgb { r, g, b }
}

