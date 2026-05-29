//! Kitty graphics protocol escape sequence emission.

use std::fmt::Write;

use base64_simd::STANDARD as BASE64;

const APC_START: &str = "\x1b_G";
const APC_END: &str = "\x1b\\";
const APC_START_TMUX: &str = "\x1bPtmux;\x1b\x1b_G";
const APC_END_TMUX: &str = "\x1b\x1b\\\x1b\\";

fn apc_start(out: &mut String, tmux: bool) {
    out.push_str(if tmux {
        APC_START_TMUX
    } else {
        APC_START
    });
}

fn apc_end(out: &mut String, tmux: bool) {
    out.push_str(if tmux {
        APC_END_TMUX
    } else {
        APC_END
    });
}

pub(super) fn transmit_raw(
    out: &mut String,
    image_id: u32,
    fmt: u8,
    bytes: &[u8],
    px_w: u32,
    px_h: u32,
    tmux: bool,
) {
    transmit(out, bytes, tmux, |apc, m| {
        write!(apc, "a=t,t=d,f={},s={},v={},q=2,i={},m={};", fmt, px_w, px_h, image_id, m)
            .unwrap();
    });
}

pub(super) fn transmit_png(out: &mut String, image_id: u32, bytes: &[u8], tmux: bool) {
    transmit(out, bytes, tmux, |apc, m| {
        write!(apc, "a=t,t=d,f=100,q=2,i={},m={};", image_id, m).unwrap();
    });
}

#[cfg(unix)]
pub(super) fn transmit_raw_shm(
    out: &mut String,
    image_id: u32,
    fmt: u8,
    name: &str,
    px_w: u32,
    px_h: u32,
    tmux: bool,
) {
    apc_start(out, tmux);
    write!(out, "a=t,t=s,f={},s={},v={},q=2,i={};", fmt, px_w, px_h, image_id).unwrap();
    out.push_str(&BASE64.encode_to_string(name.as_bytes()));
    apc_end(out, tmux);
}

#[cfg(unix)]
pub(super) fn transmit_png_shm(out: &mut String, image_id: u32, name: &str, tmux: bool) {
    apc_start(out, tmux);
    write!(out, "a=t,t=s,f=100,q=2,i={};", image_id).unwrap();
    out.push_str(&BASE64.encode_to_string(name.as_bytes()));
    apc_end(out, tmux);
}

fn transmit(
    out: &mut String,
    bytes: &[u8],
    tmux: bool,
    write_first_header: impl Fn(&mut String, u8),
) {
    let b64 = BASE64.encode_to_string(bytes);
    let chunk_size = 4096;
    let total_chunks = b64.len().div_ceil(chunk_size).max(1);
    out.reserve(b64.len() + total_chunks * 96);

    for i in 0..total_chunks {
        let start = i * chunk_size;
        let end = (start + chunk_size).min(b64.len());
        let chunk = &b64[start..end];
        let is_last = i + 1 == total_chunks;
        let more_chunks: u8 = if is_last {
            0
        } else {
            1
        };
        apc_start(out, tmux);
        if i == 0 {
            write_first_header(out, more_chunks);
        } else {
            write!(out, "m={};", more_chunks).unwrap();
        }
        out.push_str(chunk);
        apc_end(out, tmux);
    }
}

pub(super) fn placement(
    out: &mut String,
    image_id: u32,
    placement_id: u32,
    cols: u16,
    rows: u16,
    tmux: bool,
) {
    apc_start(out, tmux);
    write!(
        out,
        "a=p,U=1,i={},p={},c={},r={},q=2;",
        image_id, placement_id, cols, rows,
    )
    .unwrap();
    apc_end(out, tmux);
}

pub(super) fn free(out: &mut String, image_id: u32, tmux: bool) {
    apc_start(out, tmux);
    write!(out, "a=d,d=I,i={},q=2;", image_id).unwrap();
    apc_end(out, tmux);
}

pub(super) fn free_placement(out: &mut String, image_id: u32, placement_id: u32, tmux: bool) {
    apc_start(out, tmux);
    write!(out, "a=d,d=i,i={},p={},q=2;", image_id, placement_id).unwrap();
    apc_end(out, tmux);
}
