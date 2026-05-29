//! Glyph atlas texture with shelf packing.

use std::collections::HashMap;

use super::super::font::FontCache;
use super::decoration::{self, DecoStyle};

#[derive(Clone, Copy)]
pub(super) struct AtlasEntry {
    pub atlas_uv: [u16; 2],
    pub size_px: [u16; 2],
    pub off_px: [i16; 2],
}

pub(super) struct GlyphAtlas {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    width: u32,
    height: u32,
    shelf_y: u32,
    shelf_h: u32,
    cursor_x: u32,
    generation: u32,
    entries_ascii: Box<[Option<AtlasEntry>; Self::ASCII_RANGE * Self::ASCII_VARIANTS]>,
    entries_unicode: HashMap<(char, bool, bool), Option<AtlasEntry>>,
    deco_entries: [Option<AtlasEntry>; Self::DECO_SLOTS],
}

impl GlyphAtlas {
    const MAX_ATLAS_HEIGHT: u32 = 4096;
    const ASCII_RANGE: usize = 128;
    const ASCII_VARIANTS: usize = 4;
    const DECO_SLOTS: usize = 10;

    fn ascii_idx(c: char, bold: bool, italic: bool) -> Option<usize> {
        let n = c as u32;
        if n >= Self::ASCII_RANGE as u32 {
            return None;
        }
        let style = ((bold as usize) << 1) | italic as usize;
        Some(n as usize * Self::ASCII_VARIANTS + style)
    }

    fn deco_idx(style: DecoStyle) -> usize {
        match style {
            DecoStyle::Underline(u) => u as usize,
            DecoStyle::Strikethrough => 6,
            DecoStyle::CursorBeam => 7,
            DecoStyle::CursorUnderline => 8,
            DecoStyle::CursorBlockOutline => 9,
        }
    }
}

impl GlyphAtlas {
    pub fn new(device: &wgpu::Device, width: u32, height: u32) -> std::io::Result<Self> {
        let texture = create_texture(device, width, height);
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Ok(Self {
            texture,
            view,
            width,
            height,
            shelf_y: 0,
            shelf_h: 0,
            cursor_x: 0,
            generation: 0,
            entries_ascii: Box::new([None; Self::ASCII_RANGE * Self::ASCII_VARIANTS]),
            entries_unicode: HashMap::new(),
            deco_entries: [None; Self::DECO_SLOTS],
        })
    }

    pub fn get_view(&self) -> &wgpu::TextureView {
        &self.view
    }

    pub fn get_size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn get_generation(&self) -> u32 {
        self.generation
    }

    /// Clears all cached atlas entries.
    pub fn clear(&mut self) {
        self.shelf_y = 0;
        self.shelf_h = 0;
        self.cursor_x = 0;
        self.entries_ascii.fill(None);
        self.entries_unicode.clear();
        self.deco_entries.fill(None);
    }

    /// Returns the [`AtlasEntry`] for a decoration sprite, uploading it if not cached.
    pub fn decoration_entry(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        style: DecoStyle,
        font: &FontCache,
    ) -> Option<AtlasEntry> {
        let idx = Self::deco_idx(style);
        if let Some(cached) = self.deco_entries[idx] {
            return Some(cached);
        }
        let cell_w = font.get_cell_w();
        let cell_h = font.get_cell_h();
        let (u_pos, u_thk, s_pos, s_thk) = font.get_deco_metrics();
        let bitmap = decoration::rasterize(style, cell_w, cell_h, u_pos, u_thk, s_pos, s_thk);
        let entry = self.alloc_and_upload(device, queue, &bitmap, cell_w, cell_h, 0, 0);
        self.deco_entries[idx] = entry;
        entry
    }

    /// Returns the `AtlasEntry` for a glyph, uploading it if not cached.
    pub fn entry(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        c: char,
        bold: bool,
        italic: bool,
        font: &mut FontCache,
    ) -> Option<AtlasEntry> {
        if let Some(idx) = Self::ascii_idx(c, bold, italic) {
            if let Some(cached) = self.entries_ascii[idx] {
                return Some(cached);
            }
            let entry = self.upload(device, queue, c, bold, italic, font);
            self.entries_ascii[idx] = entry;
            return entry;
        }
        let key = (c, bold, italic);
        if let Some(cached) = self.entries_unicode.get(&key) {
            return *cached;
        }
        let entry = self.upload(device, queue, c, bold, italic, font);
        self.entries_unicode.insert(key, entry);
        entry
    }

    fn upload(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        c: char,
        bold: bool,
        italic: bool,
        font: &mut FontCache,
    ) -> Option<AtlasEntry> {
        let cell_w = font.get_cell_w();
        let cell_h = font.get_cell_h();
        if let Some(mask) = font.get_box_mask(c) {
            return self.alloc_and_upload(device, queue, mask, cell_w, cell_h, 0, 0);
        }
        let g = font.get_glyph(c, bold, italic);
        if g.get_width() == 0 || g.get_height() == 0 {
            return Some(AtlasEntry {
                atlas_uv: [0, 0],
                size_px: [0, 0],
                off_px: [0, 0],
            });
        }
        let mut bitmap = g.get_bitmap().to_vec();
        let mut w = g.get_width() as usize;
        let h = g.get_height() as usize;
        let x_off = g.get_x_off();
        let y_off = g.get_y_off();
        let synth_bold = g.is_synth_bold();
        let synth_italic = g.is_synth_italic();
        if synth_bold {
            bitmap = dilate_horizontal(&bitmap, w, h);
        }
        if synth_italic {
            let (sheared, new_w) = shear_horizontal(&bitmap, w, h);
            bitmap = sheared;
            w = new_w;
        }
        self.alloc_and_upload(device, queue, &bitmap, w as u32, h as u32, x_off, y_off)
    }

    fn alloc_and_upload(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bitmap: &[u8],
        w: u32,
        h: u32,
        x_off: i32,
        y_off: i32,
    ) -> Option<AtlasEntry> {
        let (x, y) = self.alloc(device, queue, w, h)?;
        if w > 0 && h > 0 {
            queue.write_texture(
                wgpu::ImageCopyTexture {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x, y, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                bitmap,
                wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(w),
                    rows_per_image: Some(h),
                },
                wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
            );
        }
        Some(AtlasEntry {
            atlas_uv: [x as u16, y as u16],
            size_px: [w as u16, h as u16],
            off_px: [x_off as i16, y_off as i16],
        })
    }

    fn alloc(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        w: u32,
        h: u32,
    ) -> Option<(u32, u32)> {
        if w > self.width || h > Self::MAX_ATLAS_HEIGHT {
            return None;
        }
        if self.cursor_x + w > self.width {
            self.shelf_y += self.shelf_h;
            self.shelf_h = 0;
            self.cursor_x = 0;
        }
        while self.shelf_y + h > self.height {
            if !self.try_grow(device, queue) {
                return None;
            }
        }
        let x = self.cursor_x;
        let y = self.shelf_y;
        self.cursor_x += w;
        if h > self.shelf_h {
            self.shelf_h = h;
        }
        Some((x, y))
    }

    fn try_grow(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) -> bool {
        if self.height >= Self::MAX_ATLAS_HEIGHT {
            return false;
        }
        let new_h = (self.height * 2).min(Self::MAX_ATLAS_HEIGHT);
        if new_h <= self.height {
            return false;
        }
        let new_tex = create_texture(device, self.width, new_h);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("atlas grow copy"),
        });
        encoder.copy_texture_to_texture(
            wgpu::ImageCopyTexture {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyTexture {
                texture: &new_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit(std::iter::once(encoder.finish()));
        self.view = new_tex.create_view(&wgpu::TextureViewDescriptor::default());
        self.texture = new_tex;
        self.height = new_h;
        self.generation = self.generation.wrapping_add(1);
        true
    }
}

fn create_texture(device: &wgpu::Device, w: u32, h: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("glyph atlas"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

fn dilate_horizontal(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len());
    for y in 0..h {
        let row = &src[y * w..y * w + w];
        for x in 0..w {
            let here = row[x];
            let left = if x == 0 {
                0
            } else {
                row[x - 1]
            };
            out.push(here.max(left));
        }
    }
    out
}

fn shear_horizontal(src: &[u8], w: usize, h: usize) -> (Vec<u8>, usize) {
    if w == 0 || h == 0 {
        return (src.to_vec(), w);
    }
    let shear_num = 1usize;
    let shear_den = 5usize;
    let max_shift = ((h - 1) * shear_num) / shear_den;
    let new_w = w + max_shift;
    let mut out = vec![0u8; new_w * h];
    for y in 0..h {
        let shift = ((h - 1 - y) * shear_num) / shear_den;
        let dst_row_start = y * new_w + shift;
        let src_row_start = y * w;
        out[dst_row_start..dst_row_start + w].copy_from_slice(&src[src_row_start..src_row_start + w]);
    }
    (out, new_w)
}
