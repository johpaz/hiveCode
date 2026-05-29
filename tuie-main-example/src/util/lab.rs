use super::rgb::Rgb;

#[derive(Clone, Copy)]
pub struct Lab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

fn srgb_to_linear(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(v: f64) -> f64 {
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

const D65_X: f64 = 0.95047;
const D65_Y: f64 = 1.0;
const D65_Z: f64 = 1.08883;

fn lab_f(t: f64) -> f64 {
    if t > 0.008856 {
        t.cbrt()
    } else {
        7.787 * t + 16.0 / 116.0
    }
}

fn lab_f_inv(t: f64) -> f64 {
    if t > 0.206893 {
        t * t * t
    } else {
        (t - 16.0 / 116.0) / 7.787
    }
}

pub fn from_rgb(rgb: Rgb) -> Lab {
    let r_lin = srgb_to_linear(rgb.r as f64 / 255.0);
    let g_lin = srgb_to_linear(rgb.g as f64 / 255.0);
    let b_lin = srgb_to_linear(rgb.b as f64 / 255.0);

    let x = 0.4124564 * r_lin + 0.3575761 * g_lin + 0.1804375 * b_lin;
    let y = 0.2126729 * r_lin + 0.7151522 * g_lin + 0.0721750 * b_lin;
    let z = 0.0193339 * r_lin + 0.1191920 * g_lin + 0.9503041 * b_lin;

    let fx = lab_f(x / D65_X);
    let fy = lab_f(y / D65_Y);
    let fz = lab_f(z / D65_Z);

    Lab {
        l: 116.0 * fy - 16.0,
        a: 500.0 * (fx - fy),
        b: 200.0 * (fy - fz),
    }
}

pub fn to_rgb(lab: Lab) -> Rgb {
    let fy = (lab.l + 16.0) / 116.0;
    let fx = lab.a / 500.0 + fy;
    let fz = fy - lab.b / 200.0;

    let x = D65_X * lab_f_inv(fx);
    let y = D65_Y * lab_f_inv(fy);
    let z = D65_Z * lab_f_inv(fz);

    let r_lin = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
    let g_lin = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
    let b_lin = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

    let r = (linear_to_srgb(r_lin).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    let g = (linear_to_srgb(g_lin).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    let b = (linear_to_srgb(b_lin).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;

    Rgb { r, g, b }
}

pub fn lerp(t: f64, a: Lab, b: Lab) -> Lab {
    Lab {
        l: a.l + t * (b.l - a.l),
        a: a.a + t * (b.a - a.a),
        b: a.b + t * (b.b - a.b),
    }
}

