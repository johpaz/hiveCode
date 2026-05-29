//! WGSL shaders and render pipelines for the bg and glyph passes.

const SHADER_SRC: &str = r#"
fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let cutoff = vec3<f32>(0.04045);
    let lo = c / vec3<f32>(12.92);
    let hi = pow((c + vec3<f32>(0.055)) / vec3<f32>(1.055), vec3<f32>(2.4));
    return select(hi, lo, c <= cutoff);
}

// Quad corner from vertex_index for a 4-vertex triangle strip.
// vid bit 0 -> x, vid bit 1 -> y. Strip order: (0,0) (1,0) (0,1) (1,1).
fn quad_corner(vid: u32) -> vec2<f32> {
    return vec2<f32>(f32(vid & 1u), f32((vid >> 1u) & 1u));
}

// === bg ===

struct BgUniforms {
    viewport_px: vec2<f32>,
    bg_alpha: f32,
    _pad: f32,
}
@group(0) @binding(0) var<uniform> bg_u: BgUniforms;

struct BgIn {
    @location(0) rect_px: vec4<i32>,
    @location(1) bg_rgba: vec4<f32>,
}

struct BgVsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
}

@vertex
fn vs_bg(inst: BgIn, @builtin(vertex_index) vid: u32) -> BgVsOut {
    let corner = quad_corner(vid);
    let origin = vec2<f32>(f32(inst.rect_px.x), f32(inst.rect_px.y));
    let size   = vec2<f32>(f32(inst.rect_px.z), f32(inst.rect_px.w));
    let pos    = origin + corner * size;
    var clip   = (pos / bg_u.viewport_px) * 2.0 - vec2<f32>(1.0, 1.0);
    clip.y = -clip.y;
    var out: BgVsOut;
    out.pos = vec4<f32>(clip, 0.0, 1.0);
    out.color = vec4<f32>(srgb_to_linear(inst.bg_rgba.rgb), inst.bg_rgba.a * bg_u.bg_alpha);
    return out;
}

@fragment
fn fs_bg(in: BgVsOut) -> @location(0) vec4<f32> {
    return in.color;
}

// === glyph ===

struct GlyphUniforms {
    viewport_px: vec2<f32>,
    cell_px: vec2<f32>,
    pad_px: vec2<f32>,
    atlas_px: vec2<f32>,
}
@group(0) @binding(0) var<uniform> g_u: GlyphUniforms;
@group(0) @binding(1) var g_sampler: sampler;
@group(0) @binding(2) var g_atlas: texture_2d<f32>;

struct GlyphIn {
    @location(0) cell_xy: vec2<u32>,
    @location(1) glyph_off_px: vec2<i32>,
    @location(2) glyph_size_px: vec2<u32>,
    @location(3) atlas_uv_px: vec2<u32>,
    @location(4) fg_rgba: vec4<f32>,
}

struct GlyphVsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
}

@vertex
fn vs_glyph(inst: GlyphIn, @builtin(vertex_index) vid: u32) -> GlyphVsOut {
    let corner = quad_corner(vid);
    let origin = vec2<f32>(inst.cell_xy) * g_u.cell_px + vec2<f32>(inst.glyph_off_px);
    let size = vec2<f32>(inst.glyph_size_px);
    var pos = origin + corner * size + g_u.pad_px;
    var clip = (pos / g_u.viewport_px) * 2.0 - vec2<f32>(1.0, 1.0);
    clip.y = -clip.y;
    var out: GlyphVsOut;
    out.pos = vec4<f32>(clip, 0.0, 1.0);
    out.uv = (vec2<f32>(inst.atlas_uv_px) + corner * size) / g_u.atlas_px;
    out.color = vec4<f32>(srgb_to_linear(inst.fg_rgba.rgb), inst.fg_rgba.a);
    return out;
}

@fragment
fn fs_glyph(in: GlyphVsOut) -> @location(0) vec4<f32> {
    let a = textureSample(g_atlas, g_sampler, in.uv).r;
    return vec4<f32>(in.color.rgb, in.color.a * a);
}
"#;

#[repr(C)]
#[derive(Clone, Copy)]
pub(super) struct BgUniforms {
    pub viewport_px: [f32; 2],
    pub bg_alpha: f32,
    pub _pad: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub(super) struct GlyphUniforms {
    pub viewport_px: [f32; 2],
    pub cell_px: [f32; 2],
    pub pad_px: [f32; 2],
    pub atlas_px: [f32; 2],
}

pub(super) struct BgPipeline {
    pub pipeline: wgpu::RenderPipeline,
    pub uniform_buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
}

pub(super) struct GlyphPipeline {
    pub pipeline: wgpu::RenderPipeline,
    pub uniform_buffer: wgpu::Buffer,
    pub sampler: wgpu::Sampler,
    pub bind_group_layout: wgpu::BindGroupLayout,
}

impl BgPipeline {
    const ATTRS: [wgpu::VertexAttribute; 2] = wgpu::vertex_attr_array![
        0 => Sint16x4,
        1 => Unorm8x4,
    ];

    pub fn new(device: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Self {
        let shader = shader_module(device);
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("bg uniforms"),
            size: std::mem::size_of::<BgUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("bg bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<BgUniforms>() as u64),
                },
                count: None,
            }],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bg bg"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("bg pipeline layout"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("bg pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_bg"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: 12,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &Self::ATTRS,
                }],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_bg"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        Self {
            pipeline,
            uniform_buffer,
            bind_group,
        }
    }
}

impl GlyphPipeline {
    const ATTRS: [wgpu::VertexAttribute; 5] = wgpu::vertex_attr_array![
        0 => Uint16x2,
        1 => Sint16x2,
        2 => Uint16x2,
        3 => Uint16x2,
        4 => Unorm8x4,
    ];

    pub fn new(device: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Self {
        let shader = shader_module(device);
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("glyph uniforms"),
            size: std::mem::size_of::<GlyphUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("glyph sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glyph bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(
                            std::mem::size_of::<GlyphUniforms>() as u64,
                        ),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("glyph pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("glyph pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_glyph"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: 20,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &Self::ATTRS,
                }],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_glyph"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        Self {
            pipeline,
            uniform_buffer,
            sampler,
            bind_group_layout,
        }
    }

    pub fn make_bind_group(
        &self,
        device: &wgpu::Device,
        atlas_view: &wgpu::TextureView,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glyph bg"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(atlas_view),
                },
            ],
        })
    }
}

fn shader_module(device: &wgpu::Device) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("tuie cell shaders"),
        source: wgpu::ShaderSource::Wgsl(SHADER_SRC.into()),
    })
}

pub(super) fn bytes_of<T: Copy>(v: &T) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v as *const T as *const u8, std::mem::size_of::<T>()) }
}

pub(super) fn slice_bytes<T: Copy>(slice: &[T]) -> &[u8] {
    let len = std::mem::size_of_val(slice);
    unsafe { std::slice::from_raw_parts(slice.as_ptr() as *const u8, len) }
}
