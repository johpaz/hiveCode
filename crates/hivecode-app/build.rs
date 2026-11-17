//! Optionally embeds the TUI program in the binary: `HIVETUI_EMBED=/path/to/hivetui cargo build --release`.
//! Without it the binary looks for the TUI at run time (see `tui::find_tui`).
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=HIVETUI_EMBED");
    println!("cargo:rerun-if-changed=build.rs");
    let out =
        PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("embedded_tui.rs");
    let source = match env::var("HIVETUI_EMBED") {
        Ok(path) if !path.is_empty() => {
            let path =
                fs::canonicalize(&path).unwrap_or_else(|e| panic!("HIVETUI_EMBED={path}: {e}"));
            println!("cargo:rerun-if-changed={}", path.display());
            format!(
                "pub const EMBEDDED: Option<&[u8]> = Some(include_bytes!({:?}));\n",
                path.display().to_string()
            )
        }
        _ => "pub const EMBEDDED: Option<&[u8]> = None;\n".to_owned(),
    };
    fs::write(out, source).expect("write embedded_tui.rs");
}
